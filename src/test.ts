import type { BetterAuthOptions } from "@better-auth/core";
import type {
  AdapterFactoryOptions,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import type { Surreal } from "surrealdb";
import {
  BoundQuery,
  DateTime,
  RecordId,
  ServerError,
  StringRecordId,
  Table,
  and,
  contains,
  eq,
  escapeIdent,
  expr,
  gt,
  gte,
  inside,
  lt,
  lte,
  ne,
  not,
  or,
  raw,
  surql,
} from "surrealdb";

type SurrealQueryClient = Pick<Surreal, "query">;
type SurrealClient = SurrealQueryClient & Pick<Surreal, "beginTransaction">;
type SurrealTransactionClient = Awaited<ReturnType<Surreal["beginTransaction"]>>;
type ExprLike = Parameters<typeof and>[0];

type WhereOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with";

type RecordIdFormat = "native" | "uuidv7" | "ulid";

interface SurrealAdapterConfig {
  recordIdFormat?: RecordIdFormat;
}

const SUPPORTED_RECORD_ID_FORMATS = [
  "native",
  "uuidv7",
  "ulid",
] as const satisfies readonly RecordIdFormat[];

const adapterError = (message: string, cause?: unknown) =>
  new Error(`[surrealdb-adapter] ${message}`, cause ? { cause } : undefined);

const isSurrealRecordId = (value: unknown): value is RecordId | StringRecordId =>
  value instanceof StringRecordId || value instanceof RecordId;

const asStringRecordId = (value: unknown, table: string): StringRecordId => {
  if (isSurrealRecordId(value)) return new StringRecordId(value.toString());
  if (typeof value === "string") {
    const input = value.includes(":") ? value : `${table}:${value}`;
    return new StringRecordId(input);
  }
  throw adapterError(`Invalid record ID: ${String(value)}`);
};

const asStringRecordIdInput = (
  value: unknown,
  table: string,
): StringRecordId | StringRecordId[] => {
  if (value === null || value === undefined)
    throw adapterError(`Invalid record ID: ${String(value)}`);
  if (Array.isArray(value)) return value.map((item) => asStringRecordId(item, table));
  return asStringRecordId(value, table);
};

const splitUpdateData = (data: Record<string, unknown>) =>
  Object.entries(data).reduce<{
    mergeData: Record<string, unknown>;
    setNoneFields: string[];
  }>(
    (acc, [key, value]) => {
      if (value === undefined) return acc;
      if (value === null) acc.setNoneFields.push(key);
      else acc.mergeData[key] = value;
      return acc;
    },
    { mergeData: {}, setNoneFields: [] },
  );

const buildSetNone = (fields: string[]) =>
  fields.map((field) => `${escapeIdent(field)} = NONE`).join(", ");

const startsWithExpr = (field: string, value: string): ExprLike => ({
  toSQL: (ctx) => `string::starts_with(${field}, ${ctx.def(value)})`,
});

const endsWithExpr = (field: string, value: string): ExprLike => ({
  toSQL: (ctx) => `string::ends_with(${field}, ${ctx.def(value)})`,
});

const expectArray = (value: unknown, operator: "in" | "not_in"): unknown[] => {
  if (Array.isArray(value)) return value;
  throw adapterError(`Operator "${operator}" requires an array value.`);
};

const expectString = (value: unknown, operator: "starts_with" | "ends_with"): string => {
  if (typeof value === "string") return value;
  throw adapterError(`Operator "${operator}" requires a string value.`);
};

const appendWhereClause = (query: BoundQuery, whereClause: BoundQuery): BoundQuery => {
  if (!whereClause.query) return query;
  query.append(new BoundQuery(` ${whereClause.query}`, whereClause.bindings));
  return query;
};

const toTableIdent = (table: string) => new Table(table).toString();

const createTargetExpression = (table: string, format: RecordIdFormat): string => {
  const escapedTable = toTableIdent(table);
  if (format === "uuidv7") return `${escapedTable}:uuid()`;
  if (format === "ulid") return `${escapedTable}:ulid()`;
  return escapedTable;
};

export const surrealAdapter = (client: SurrealClient, config: SurrealAdapterConfig = {}) => {
  let lazyOptions: BetterAuthOptions | undefined;
  const recordIdFormat = config.recordIdFormat ?? "native";
  if (!SUPPORTED_RECORD_ID_FORMATS.includes(recordIdFormat)) {
    throw adapterError(
      `Unsupported recordIdFormat "${String(recordIdFormat)}". Supported values are "native", "uuidv7", and "ulid".`,
    );
  }

  const createCustomAdapter =
    (db: SurrealQueryClient) =>
    ({
      getModelName,
      getFieldName,
    }: Parameters<NonNullable<AdapterFactoryOptions["adapter"]>>[0]) => {
      const resolveFieldName = (model: string, field: string) => {
        try {
          return getFieldName({ model, field });
        } catch {
          return field;
        }
      };

      const idFieldForModel = (model: string) => resolveFieldName(model, "id");
      const toTable = (model: string) => new Table(getModelName(model));
      const toSqlColumns = (model: string, select?: string[]) =>
        select?.length
          ? select.map((field) => escapeIdent(resolveFieldName(model, field))).join(", ")
          : "*";
      const mapWritePayload = (model: string, payload: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(payload).map(([field, value]) => [resolveFieldName(model, field), value]),
        ) as Record<string, unknown>;

      const exec = async <T>(query: BoundQuery): Promise<T[]> => {
        try {
          const results = await db.query<[T[]]>(query);
          return results[0] ?? [];
        } catch (error) {
          if (error instanceof ServerError) throw adapterError(error.message, error);
          throw error;
        }
      };

      const execFirst = async <T>(query: BoundQuery): Promise<T | null> =>
        (await exec<T>(query))[0] ?? null;

      const buildWhereExpr = (model: string, where: CleanedWhere[] = []): ExprLike | null => {
        if (where.length === 0) return null;

        const table = getModelName(model);
        const idField = idFieldForModel(model);

        const toConditionExpr = (entry: CleanedWhere): ExprLike => {
          const dbField = resolveFieldName(model, entry.field);
          const field = escapeIdent(dbField);
          const operator = (entry.operator ?? "eq") as WhereOperator;
          const value =
            dbField === idField ? asStringRecordIdInput(entry.value, table) : entry.value;

          switch (operator) {
            case "eq":
              return eq(field, value);
            case "ne":
              return ne(field, value);
            case "lt":
              return lt(field, value);
            case "lte":
              return lte(field, value);
            case "gt":
              return gt(field, value);
            case "gte":
              return gte(field, value);
            case "in":
              return inside(field, expectArray(value, "in"));
            case "not_in":
              return not(inside(field, expectArray(value, "not_in")));
            case "contains":
              return contains(field, value);
            case "starts_with":
              return startsWithExpr(field, expectString(value, "starts_with"));
            case "ends_with":
              return endsWithExpr(field, expectString(value, "ends_with"));
            default:
              throw adapterError(`Unsupported where operator "${String(entry.operator)}".`);
          }
        };

        const [firstWhere, ...restWhere] = where;
        if (!firstWhere) return null;

        return restWhere.reduce<ExprLike>(
          (current, entry) =>
            entry.connector === "OR"
              ? or(current, toConditionExpr(entry))
              : and(current, toConditionExpr(entry)),
          toConditionExpr(firstWhere),
        );
      };

      const toWhereClause = (model: string, where: CleanedWhere[] = []): BoundQuery => {
        const whereExpr = buildWhereExpr(model, where);
        if (!whereExpr) return new BoundQuery("");
        const compiled = expr(whereExpr);
        return compiled.query
          ? new BoundQuery(`WHERE ${compiled.query}`, compiled.bindings)
          : new BoundQuery("");
      };

      const countWhere = async (model: string, where: CleanedWhere[] = []): Promise<number> => {
        const table = toTable(model);
        const query = appendWhereClause(
          surql`SELECT count() AS total FROM ${table}`,
          toWhereClause(model, where),
        );
        query.append(" GROUP ALL;");
        const row = await execFirst<{ total: number }>(query);
        return row?.total ?? 0;
      };

      const resolveSingleId = async (
        model: string,
        where: CleanedWhere[],
      ): Promise<string | null> => {
        const table = getModelName(model);
        const tableRef = toTable(model);
        const idField = idFieldForModel(model);
        const firstWhere = where[0];

        if (
          where.length === 1 &&
          firstWhere !== undefined &&
          resolveFieldName(model, String(firstWhere.field ?? "")) === idField &&
          firstWhere.operator === "eq"
        ) {
          return asStringRecordId(firstWhere.value, table).toString();
        }

        const query = appendWhereClause(
          surql`SELECT VALUE ${raw(escapeIdent(idField))} FROM ${tableRef}`,
          toWhereClause(model, where),
        );
        query.append(" LIMIT 1;");
        const row = await execFirst<string>(query);
        return row ?? null;
      };

      const customAdapter: CustomAdapter = {
        async create<T>({
          model,
          data,
        }: {
          model: string;
          data: Record<string, unknown>;
        }): Promise<T> {
          const table = getModelName(model);
          const idField = idFieldForModel(model);
          const mappedData = mapWritePayload(model, data);
          const explicitId = mappedData[idField] ?? mappedData.id;

          if (explicitId !== undefined && explicitId !== null) {
            const id = asStringRecordId(explicitId, table).toString();
            const content = { ...mappedData };
            delete content[idField];
            delete content.id;
            const created = await execFirst<T>(
              new BoundQuery(`CREATE ONLY ${id} CONTENT $data RETURN AFTER`, { data: content }),
            );
            if (!created) throw adapterError(`Failed to create ${table} record.`);
            return created;
          }

          const created = await execFirst<T>(
            new BoundQuery(
              `CREATE ONLY ${createTargetExpression(table, recordIdFormat)} CONTENT $data RETURN AFTER`,
              {
                data: mappedData,
              },
            ),
          );
          if (!created) throw adapterError(`Failed to create ${table} record.`);
          return created;
        },

        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[];
        }): Promise<T | null> {
          const table = toTable(model);
          const columns = raw(toSqlColumns(model, select));
          const query = appendWhereClause(
            surql`SELECT ${columns} FROM ${table}`,
            toWhereClause(model, where),
          );
          query.append(" LIMIT 1;");
          return execFirst<T>(query);
        },

        async findMany<T>({
          model,
          where,
          limit,
          offset,
          sortBy,
          select,
        }: {
          model: string;
          where?: CleanedWhere[];
          limit?: number;
          offset?: number;
          sortBy?: { field: string; direction: "asc" | "desc" };
          select?: string[];
        }): Promise<T[]> {
          const table = toTable(model);
          const columns = raw(toSqlColumns(model, select));
          const query = appendWhereClause(
            surql`SELECT ${columns} FROM ${table}`,
            toWhereClause(model, where ?? []),
          );

          if (sortBy) {
            const sortField = raw(escapeIdent(resolveFieldName(model, sortBy.field)));
            const sortDirection = raw(sortBy.direction.toUpperCase());
            query.append(surql` ORDER BY ${sortField} ${sortDirection}`);
          }
          if (limit !== undefined) query.append(" LIMIT $limit", { limit });
          if (offset !== undefined) query.append(" START $offset", { offset });
          query.append(";");

          return exec<T>(query);
        },

        count({ model, where }: { model: string; where?: CleanedWhere[] }): Promise<number> {
          return countWhere(model, where);
        },

        async update<T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: T;
        }): Promise<T | null> {
          const id = await resolveSingleId(model, where);
          if (!id) return null;

          if (typeof update !== "object" || update === null || Array.isArray(update)) {
            throw adapterError(`Expected update payload for model "${model}" to be an object.`);
          }

          const mappedUpdate = mapWritePayload(model, update as Record<string, unknown>);
          const { mergeData, setNoneFields } = splitUpdateData(mappedUpdate);

          if (Object.keys(mergeData).length > 0) {
            await exec(new BoundQuery(`UPDATE ${id} MERGE $data`, { data: mergeData }));
          }
          if (setNoneFields.length > 0) {
            await exec(new BoundQuery(`UPDATE ${id} SET ${buildSetNone(setNoneFields)}`));
          }

          return execFirst<T>(new BoundQuery(`SELECT * FROM ONLY ${id} LIMIT 1;`));
        },

        async updateMany({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: Record<string, unknown>;
        }): Promise<number> {
          const affected = await countWhere(model, where);
          if (affected === 0) return 0;

          const table = toTable(model);
          const mappedUpdate = mapWritePayload(model, update);
          const { mergeData, setNoneFields } = splitUpdateData(mappedUpdate);
          const whereClause = toWhereClause(model, where);

          if (Object.keys(mergeData).length > 0) {
            const query = appendWhereClause(surql`UPDATE ${table} MERGE ${mergeData}`, whereClause);
            await exec(query);
          }

          if (setNoneFields.length > 0) {
            const query = appendWhereClause(surql`UPDATE ${table}`, whereClause);
            query.append(` SET ${buildSetNone(setNoneFields)}`);
            await exec(query);
          }

          return affected;
        },

        async delete({ model, where }: { model: string; where: CleanedWhere[] }): Promise<void> {
          const id = await resolveSingleId(model, where);
          if (!id) return;
          await exec(new BoundQuery(`DELETE ${id}`));
        },

        async deleteMany({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }): Promise<number> {
          const affected = await countWhere(model, where);
          if (affected === 0) return 0;

          const query = appendWhereClause(
            surql`DELETE ${toTable(model)}`,
            toWhereClause(model, where),
          );
          await exec(query);
          return affected;
        },

        async createSchema({ tables }: { tables: BetterAuthDBSchema }) {
          let code = "";
          for (const { modelName, fields } of Object.values(tables)) {
            const table = toTableIdent(getModelName(modelName));
            code += `DEFINE TABLE OVERWRITE ${table} SCHEMAFULL;\n`;

            for (const [fieldKey, field] of Object.entries(fields)) {
              const dbField = escapeIdent(resolveFieldName(modelName, field.fieldName ?? fieldKey));
              if (dbField === "id") continue;

              const fieldType = field.references
                ? `record<${toTableIdent(getModelName(field.references.model))}>`
                : "any";
              const typeDef = field.required ? fieldType : `option<${fieldType}>`;
              code += `DEFINE FIELD OVERWRITE ${dbField} ON TABLE ${table} TYPE ${typeDef};\n`;
              if (field.unique) {
                code += `DEFINE INDEX OVERWRITE ${dbField}_idx ON TABLE ${table} COLUMNS ${dbField} UNIQUE;\n`;
              }
            }

            code += "\n";
          }

          return { code, path: ".better-auth/schema.surql" };
        },
      };

      return customAdapter;
    };

  const adapterFactoryOptions: AdapterFactoryOptions = {
    config: {
      adapterId: "surrealdb",
      adapterName: "SurrealDB Adapter",
      supportsJSON: true,
      supportsArrays: true,
      supportsDates: true,
      supportsBooleans: true,
      disableIdGeneration: true,
      customTransformInput: ({ data, field, fieldAttributes, model }) => {
        if (data === undefined || data === null) return data;
        if (fieldAttributes.type === "date" && data instanceof Date) return new DateTime(data);
        if (field === "id") return asStringRecordId(data, model).toString();
        if (fieldAttributes.references?.model) {
          return asStringRecordId(data, fieldAttributes.references.model).toString();
        }
        return data;
      },
      customTransformOutput: ({ data, fieldAttributes }) => {
        if (data === undefined || data === null) return data;
        if (fieldAttributes.type === "date" && data instanceof DateTime) return data.toDate();
        if (data instanceof RecordId || data instanceof StringRecordId) return data.toString();
        return data;
      },
      transaction: async (callback) => {
        const tx: SurrealTransactionClient = await client.beginTransaction();
        if (!lazyOptions) {
          throw adapterError("Adapter options were not initialized before transaction execution.");
        }

        const txAdapter = createAdapterFactory({
          config: {
            ...adapterFactoryOptions.config,
            transaction: false,
          },
          adapter: createCustomAdapter(tx as unknown as SurrealQueryClient),
        })(lazyOptions);

        try {
          const result = await callback(txAdapter);
          await tx.commit();
          return result;
        } catch (error) {
          try {
            await tx.cancel();
          } catch {}
          throw error;
        }
      },
    },
    adapter: createCustomAdapter(client),
  };

  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    lazyOptions = options;
    return createAdapterFactory(adapterFactoryOptions)(options);
  };
};
