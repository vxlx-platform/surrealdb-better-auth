import type { BetterAuthOptions } from "@better-auth/core";
import type {
  AdapterFactoryOptions,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterDebugLogOption,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import type { Expr, Surreal } from "surrealdb";
import {
  BoundQuery,
  DateTime,
  Features,
  RecordId,
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

type SurrealClient = Pick<Surreal, "query" | "create" | "beginTransaction" | "isFeatureSupported">;
type SurrealQueryClient = Pick<SurrealClient, "query" | "create">;
type SurrealTransactionClient = Awaited<ReturnType<SurrealClient["beginTransaction"]>>;

type RecordIdFormat = "native" | "uuidv7" | "ulid";

type RecordIdFormatResolver = RecordIdFormat | ((input: { model: string }) => RecordIdFormat);

export interface SurrealAdapterConfig {
  debugLogs?: DBAdapterDebugLogOption;
  usePlural?: boolean;
  transaction?: boolean;
  recordIdFormat?: RecordIdFormatResolver;
  defineAccess?: () => BoundQuery<unknown[]>;
}

const SUPPORTED_RECORD_ID_FORMATS = [
  "native",
  "uuidv7",
  "ulid",
] as const satisfies readonly RecordIdFormat[];

type SchemaField = Pick<
  DBFieldAttribute,
  "type" | "required" | "unique" | "references" | "fieldName"
>;

type QueryRows<T> = T[] | [T[]];

type AdapterSchema = Record<
  string,
  {
    modelName: string;
    fields: Record<string, { fieldName?: string }>;
  }
>;

type ModelFieldLookup = Map<string, string>;
type TransactionRunner = Exclude<
  NonNullable<AdapterFactoryOptions["config"]["transaction"]>,
  false
>;

type SurrealSchemaFieldType =
  | "string"
  | "number"
  | "bool"
  | "datetime"
  | "object"
  | "array<string>"
  | "array<number>";

const FIELD_TYPE_MAP = {
  string: "string",
  number: "number",
  boolean: "bool",
  date: "datetime",
  json: "object",
  "string[]": "array<string>",
  "number[]": "array<number>",
} as const satisfies Record<string, SurrealSchemaFieldType>;

type SupportedSchemaFieldType = keyof typeof FIELD_TYPE_MAP;

const isSupportedSchemaFieldType = (
  fieldType: SchemaField["type"],
): fieldType is SupportedSchemaFieldType =>
  typeof fieldType === "string" && fieldType in FIELD_TYPE_MAP;

const toResultRows = <T>(result: QueryRows<T>): T[] => {
  if (result.length === 0) return [];
  if (result.length === 1 && Array.isArray(result[0])) {
    return result[0];
  }
  return result.filter((value): value is T => !Array.isArray(value));
};

const toTableIdent = (table: string) => new Table(table).toString();
const toFieldIdent = (field: string) => field;
const toEscapedFieldIdent = (field: string) => escapeIdent(toFieldIdent(field));

export const surrealAdapter = (client: SurrealClient, config: SurrealAdapterConfig = {}) => {
  let lazyOptions: BetterAuthOptions | undefined;
  let adapterFactoryOptions: AdapterFactoryOptions | undefined;

  const adapterError = (message: string, cause?: unknown) =>
    new Error(`[surrealdb-adapter] ${message}`, cause === undefined ? undefined : { cause });

  const requireOptions = <T>(value: T | undefined, name: string): T => {
    if (!value) throw adapterError(`${name} was not initialized before transaction execution.`);
    return value;
  };

  const toStringRecordId = (value: unknown, expectedTable?: string): StringRecordId => {
    const asString =
      value instanceof StringRecordId || value instanceof RecordId
        ? value.toString()
        : typeof value === "string"
          ? value
          : null;

    if (!asString) {
      throw adapterError(
        `Expected a Surreal record id for ${expectedTable ?? "record"}, received "${String(value)}".`,
      );
    }

    const separator = asString.indexOf(":");
    const table = separator > 0 ? asString.slice(0, separator) : "";
    const id = separator > -1 ? asString.slice(separator + 1) : "";
    if (!table || !id) {
      throw adapterError(`Invalid record id "${asString}". Expected the format "table:id".`);
    }

    if (expectedTable && table !== expectedTable) {
      throw adapterError(
        `Record id "${asString}" references table "${table}", expected "${expectedTable}".`,
      );
    }

    return new StringRecordId(asString);
  };

  const toRecordIdInput = (
    value: unknown,
    expectedTable?: string,
  ): StringRecordId | StringRecordId[] | null | undefined => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((entry) => toStringRecordId(entry, expectedTable));
    }
    return toStringRecordId(value, expectedTable);
  };

  const resolveRecordIdFormat = (resolver: RecordIdFormatResolver | undefined, model: string) => {
    const raw = typeof resolver === "function" ? resolver({ model }) : (resolver ?? "native");
    if (!SUPPORTED_RECORD_ID_FORMATS.includes(raw)) {
      throw adapterError(
        `Unsupported recordIdFormat "${String(raw)}". Supported values are "native", "uuidv7", and "ulid".`,
      );
    }
    return raw;
  };

  const createTargetExpression = (table: string, format: RecordIdFormat): string => {
    const escapedTable = toTableIdent(table);
    if (format === "uuidv7") return `${escapedTable}:uuid()`;
    if (format === "ulid") return `${escapedTable}:ulid()`;
    return escapedTable;
  };

  const resolveSchemaType = (
    modelName: string,
    fieldName: string,
    fieldType: SchemaField["type"],
  ) => {
    if (!isSupportedSchemaFieldType(fieldType)) {
      throw adapterError(
        `Unsupported schema field type "${String(fieldType)}" for "${modelName}.${fieldName}".`,
      );
    }
    return FIELD_TYPE_MAP[fieldType];
  };

  const schemaFieldLookupCache = new WeakMap<AdapterSchema, Map<string, ModelFieldLookup>>();

  const getSchemaFieldLookup = (schema: AdapterSchema): Map<string, ModelFieldLookup> => {
    const cached = schemaFieldLookupCache.get(schema);
    if (cached) return cached;

    const lookup = new Map<string, ModelFieldLookup>(
      Object.values(schema).map((table) => [
        table.modelName,
        new Map(
          Object.entries(table.fields).map(([name, attributes]) => [
            attributes.fieldName ?? name,
            name,
          ]),
        ),
      ]),
    );

    schemaFieldLookupCache.set(schema, lookup);
    return lookup;
  };

  const resolveDefaultFieldName = (schema: AdapterSchema, model: string, field: string) =>
    getSchemaFieldLookup(schema).get(model)?.get(field) ?? field;

  const normalizeDateValue = (value: unknown) =>
    value instanceof DateTime ? value.toDate() : value;

  const normalizeRecordIdValue = (value: unknown) => {
    const asString =
      value instanceof RecordId || value instanceof StringRecordId
        ? value.toString()
        : typeof value === "string"
          ? value
          : null;

    if (!asString) return value;
    try {
      return new StringRecordId(asString).toString();
    } catch {
      return asString;
    }
  };

  const startsWithExpr = (field: string, value: string): Expr => ({
    toSQL: (ctx) => `string::starts_with(${field}, ${ctx.def(value)})`,
  });

  const endsWithExpr = (field: string, value: string): Expr => ({
    toSQL: (ctx) => `string::ends_with(${field}, ${ctx.def(value)})`,
  });

  type SupportedWhereOperator =
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

  const supportedWhereOperators = [
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "not_in",
    "contains",
    "starts_with",
    "ends_with",
  ] as const satisfies readonly SupportedWhereOperator[];
  const supportedWhereOperatorSet = new Set<SupportedWhereOperator>(supportedWhereOperators);

  const isSupportedWhereOperator = (value: unknown): value is SupportedWhereOperator =>
    typeof value === "string" && supportedWhereOperatorSet.has(value as SupportedWhereOperator);

  const expectStringValue = (value: unknown, operator: "starts_with" | "ends_with"): string => {
    if (typeof value === "string") return value;
    throw adapterError(`Operator "${operator}" requires a string value.`);
  };

  const expectArrayValue = (value: unknown, operator: "in" | "not_in"): unknown[] => {
    if (Array.isArray(value)) return value;
    throw adapterError(`Operator "${operator}" requires an array value.`);
  };

  const resolveWhereOperator = (value: unknown): SupportedWhereOperator => {
    if (value === undefined) return "eq";
    if (isSupportedWhereOperator(value)) return value;
    throw adapterError(`Unsupported where operator "${String(value)}".`);
  };

  const buildUpdateSetStatement = (
    update: Record<string, unknown>,
  ): { setClause: string; bindings: Record<string, unknown> } => {
    const assignments: string[] = [];
    const bindings: Record<string, unknown> = {};
    let index = 0;

    for (const [field, value] of Object.entries(update)) {
      if (value === undefined) continue;
      if (value === null) {
        assignments.push(`${toEscapedFieldIdent(field)} = NONE`);
        continue;
      }

      const key = `update_${index++}`;
      assignments.push(`${toEscapedFieldIdent(field)} = $${key}`);
      bindings[key] = value;
    }

    return {
      setClause: assignments.join(", "),
      bindings,
    };
  };

  const whereOperatorExprBuilders = {
    eq: (field: string, value: unknown): Expr => eq(field, value),
    ne: (field: string, value: unknown): Expr => ne(field, value),
    lt: (field: string, value: unknown): Expr => lt(field, value),
    lte: (field: string, value: unknown): Expr => lte(field, value),
    gt: (field: string, value: unknown): Expr => gt(field, value),
    gte: (field: string, value: unknown): Expr => gte(field, value),
    contains: (field: string, value: unknown): Expr => contains(field, value),
    in: (field: string, value: unknown): Expr => inside(field, expectArrayValue(value, "in")),
    not_in: (field: string, value: unknown): Expr =>
      not(inside(field, expectArrayValue(value, "not_in"))),
    starts_with: (field: string, value: unknown): Expr =>
      startsWithExpr(field, expectStringValue(value, "starts_with")),
    ends_with: (field: string, value: unknown): Expr =>
      endsWithExpr(field, expectStringValue(value, "ends_with")),
  } as const satisfies Record<SupportedWhereOperator, (field: string, value: unknown) => Expr>;

  const whereOperatorExpr = (
    operator: SupportedWhereOperator,
    field: string,
    value: unknown,
  ): Expr => whereOperatorExprBuilders[operator](field, value);

  const generateSchemaCode = ({
    file,
    tables,
    getModelName,
    getFieldName,
  }: {
    file?: string | undefined;
    tables: BetterAuthDBSchema;
    getModelName: (model: string) => string;
    getFieldName: ({ model, field }: { model: string; field: string }) => string;
  }) => {
    const buildIndexName = (tableName: string, fieldName: string): string => {
      const normalizedTable = tableName.replace(/`/g, "").toLowerCase();
      const normalizedField = fieldName.replace(/`/g, "");
      const capitalizedField = normalizedField
        ? normalizedField.charAt(0).toUpperCase() + normalizedField.slice(1)
        : "";
      return `${normalizedTable}${capitalizedField}_idx`;
    };

    const schemaLines = Object.values(tables).flatMap((table) => {
      const tableName = toTableIdent(getModelName(table.modelName));
      const fieldLines = Object.entries(table.fields).flatMap(([fieldKey, field]) => {
        const dbFieldName = field.fieldName ?? fieldKey;
        if (dbFieldName === "id") return [];

        const resolvedField = toEscapedFieldIdent(
          getFieldName({ model: table.modelName, field: dbFieldName }),
        );
        const fieldType = field.references
          ? `record<${toTableIdent(getModelName(field.references.model))}>`
          : resolveSchemaType(table.modelName, dbFieldName, field.type);
        const requiredType = field.required ? fieldType : `option<${fieldType}>`;
        const fieldDefinition = `DEFINE FIELD OVERWRITE ${resolvedField} ON TABLE ${tableName} TYPE ${requiredType};`;
        if (!field.unique) return [fieldDefinition];

        const indexName = buildIndexName(tableName, resolvedField);
        const indexDefinition = `DEFINE INDEX OVERWRITE ${escapeIdent(indexName)} ON TABLE ${tableName} COLUMNS ${resolvedField} UNIQUE;`;
        return [fieldDefinition, indexDefinition];
      });

      return [`DEFINE TABLE OVERWRITE ${tableName} SCHEMAFULL;`, ...fieldLines, ""];
    });

    const accessStatement = (() => {
      if (typeof config.defineAccess === "function") {
        const bound = config.defineAccess();
        if (Object.keys(bound.bindings).length > 0) {
          const placeholders = Object.keys(bound.bindings).map((key) => `$${key}`);
          throw adapterError(
            `defineAccess must not include bindings in schema generation. Use static surql or inline dynamic values with raw(...). Found: ${placeholders.join(", ")}.`,
          );
        }
        const statement = bound.query.trim();
        return statement.length > 0 ? statement : null;
      }
      return null;
    })();

    const lines = accessStatement
      ? [
          ...schemaLines,
          accessStatement.endsWith(";") ? accessStatement : `${accessStatement};`,
          "",
        ]
      : schemaLines;

    const suggestedPath = file ? file.replace(/\.[^/.]+$/, ".surql") : ".better-auth/schema.surql";
    return {
      code: lines.join("\n"),
      path: suggestedPath,
    };
  };

  const supportsTransactions = (): boolean => {
    if (config.transaction === false) return false;
    if (typeof client.beginTransaction !== "function") return false;
    if (typeof client.isFeatureSupported !== "function") return true;
    return client.isFeatureSupported(Features.Transactions);
  };

  const buildWhereClause = (where: CleanedWhere[] | undefined): BoundQuery => {
    if (!where || where.length === 0) return new BoundQuery("");

    const firstWhere = where[0];
    if (!firstWhere) return new BoundQuery("");

    const toConditionExpr = (item: CleanedWhere): Expr => {
      const field = toEscapedFieldIdent(item.field);
      const operator = resolveWhereOperator(item.operator);
      return whereOperatorExpr(operator, field, item.value);
    };

    const condition = where.slice(1).reduce((acc, item) => {
      const next = toConditionExpr(item);
      return item.connector === "OR" ? or(acc, next) : and(acc, next);
    }, toConditionExpr(firstWhere));

    const compiled = expr(condition);
    if (!compiled.query) return new BoundQuery("");
    return new BoundQuery(`WHERE ${compiled.query}`, compiled.bindings);
  };

  const createCustomAdapter =
    (db: SurrealQueryClient) =>
    ({
      getFieldName,
      getModelName,
    }: Parameters<NonNullable<AdapterFactoryOptions["adapter"]>>[0]) => {
      const resolveTableName = getModelName;
      const resolveFieldName = (model: string, field: string) => {
        try {
          return getFieldName({ model, field });
        } catch {
          return field;
        }
      };

      const execQuery = async <T>(query: BoundQuery) =>
        toResultRows<T>(await db.query<QueryRows<T>>(query.query, query.bindings));

      const execQueryFirst = async <T>(query: BoundQuery) => (await execQuery<T>(query))[0] ?? null;

      const appendWhereClause = (query: BoundQuery, whereClause: BoundQuery) => {
        if (!whereClause.query) return query;
        query.append(new BoundQuery(` ${whereClause.query}`, whereClause.bindings));
        return query;
      };

      const buildSelectColumns = (model: string, select?: string[]) =>
        select && select.length > 0
          ? select.map((field) => toEscapedFieldIdent(resolveFieldName(model, field))).join(", ")
          : "*";

      const idFieldForModel = (model: string) => resolveFieldName(model, "id");

      const resolveModelQueryContext = (model: string, where?: CleanedWhere[]) => {
        const resolvedTableName = resolveTableName(model);
        const tableName = toTableIdent(resolvedTableName);
        const idField = idFieldForModel(model);
        const whereClause = buildWhereClause(where);
        return { resolvedTableName, tableName, idField, whereClause };
      };

      const buildSelectQuery = (model: string, select?: string[], where?: CleanedWhere[]) => {
        const { tableName, whereClause } = resolveModelQueryContext(model, where);
        const query = new BoundQuery(
          `SELECT ${buildSelectColumns(model, select)} FROM ${tableName}`,
        );
        appendWhereClause(query, whereClause);
        return query;
      };

      const resolveSingleRecordId = async (model: string, where: CleanedWhere[]) => {
        const { resolvedTableName, tableName, idField, whereClause } = resolveModelQueryContext(
          model,
          where,
        );

        const firstWhere = where[0];

        const fastPath =
          where.length === 1 &&
          firstWhere !== undefined &&
          String(firstWhere.field ?? "") === idField &&
          firstWhere.operator === "eq";

        if (fastPath && firstWhere) {
          return toStringRecordId(firstWhere.value, resolvedTableName);
        }

        const query = new BoundQuery(
          `SELECT VALUE ${toEscapedFieldIdent(idField)} FROM ${tableName}`,
        );
        appendWhereClause(query, whereClause);
        query.append(" LIMIT 1;");

        const rows = await execQuery<StringRecordId | RecordId | string>(query);
        const first = rows[0] ?? null;
        if (!first) return null;
        return toStringRecordId(first, resolvedTableName);
      };

      const countRecords = async (model: string, where?: CleanedWhere[]) => {
        const { tableName, whereClause } = resolveModelQueryContext(model, where);
        const query = new BoundQuery(`SELECT count() AS total FROM ${tableName}`);
        appendWhereClause(query, whereClause);
        query.append(" GROUP ALL;");

        const row = await execQueryFirst<{ total: number }>(query);
        return Number(row?.total ?? 0);
      };

      const withCountBeforeMutation = async (
        model: string,
        where: CleanedWhere[],
        mutate: (context: ReturnType<typeof resolveModelQueryContext>) => Promise<void>,
      ) => {
        const countBefore = await countRecords(model, where);
        if (countBefore === 0) return 0;
        await mutate(resolveModelQueryContext(model, where));
        return countBefore;
      };

      const customAdapter: CustomAdapter = {
        async create<T extends Record<string, unknown>>({
          model,
          data,
        }: {
          model: string;
          data: T;
          select?: string[] | undefined;
        }): Promise<T> {
          const table = resolveTableName(model);
          const format = resolveRecordIdFormat(config.recordIdFormat, table);

          const query = new BoundQuery(
            `CREATE ONLY ${createTargetExpression(table, format)} CONTENT $data RETURN AFTER;`,
            { data },
          );

          const created = await execQueryFirst<T>(query);
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
          select?: string[] | undefined;
        }): Promise<T | null> {
          const query = buildSelectQuery(model, select, where);
          query.append(" LIMIT 1;");

          return await execQueryFirst<T>(query);
        },

        async findMany<T>({
          model,
          where,
          sortBy,
          limit,
          offset,
          select,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
          limit: number;
          select?: string[] | undefined;
          sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
          offset?: number | undefined;
        }): Promise<T[]> {
          const query = buildSelectQuery(model, select, where);

          if (sortBy) {
            const sortField = toEscapedFieldIdent(resolveFieldName(model, sortBy.field));
            const direction = sortBy.direction === "desc" ? "DESC" : "ASC";
            query.append(new BoundQuery(` ORDER BY ${sortField} ${direction}`));
          }

          if (typeof limit === "number") {
            query.append(" LIMIT $limit", { limit });
          }

          if (typeof offset === "number") {
            query.append(" START $offset", { offset });
          }
          query.append(";");

          return await execQuery<T>(query);
        },

        count({
          model,
          where,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
        }): Promise<number> {
          return countRecords(model, where);
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
          if (typeof update !== "object" || update === null || Array.isArray(update)) {
            throw adapterError(`Expected update payload for "${model}" to be a plain object.`);
          }

          const { tableName, whereClause } = resolveModelQueryContext(model, where);
          const { setClause, bindings } = buildUpdateSetStatement(
            update as Record<string, unknown>,
          );
          if (!setClause) {
            const existing = buildSelectQuery(model, undefined, where);
            existing.append(" LIMIT 1;");
            return await execQueryFirst<T>(existing);
          }

          const query = new BoundQuery(`UPDATE ${tableName} SET ${setClause}`, bindings);
          appendWhereClause(query, whereClause);
          query.append(" RETURN AFTER;");
          return await execQueryFirst<T>(query);
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
          return withCountBeforeMutation(
            model,
            where,
            async ({ resolvedTableName, whereClause }) => {
              const { setClause, bindings } = buildUpdateSetStatement(update);
              if (!setClause) return;

              const query = new BoundQuery(
                `UPDATE ${toTableIdent(resolvedTableName)} SET ${setClause}`,
                bindings,
              );
              appendWhereClause(query, whereClause);
              query.append(";");
              await execQuery(query);
            },
          );
        },

        async delete({ model, where }: { model: string; where: CleanedWhere[] }): Promise<void> {
          const target = await resolveSingleRecordId(model, where);
          if (!target) return;
          await execQuery(surql`DELETE ${target}`);
        },

        async deleteMany({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }): Promise<number> {
          return withCountBeforeMutation(model, where, async ({ tableName, whereClause }) => {
            const query = surql`DELETE ${raw(tableName)}`;
            appendWhereClause(query, whereClause);
            query.append(";");
            await execQuery(query);
          });
        },

        async createSchema({
          file,
          tables,
        }: {
          file?: string | undefined;
          tables: BetterAuthDBSchema;
        }) {
          return generateSchemaCode({
            tables,
            getFieldName,
            getModelName,
            ...(file ? { file } : {}),
          });
        },

        options: config,
      };

      return customAdapter;
    };

  const createTransactionRunner = (): TransactionRunner => async (callback) => {
    const tx: SurrealTransactionClient = await client.beginTransaction();
    const currentFactoryOptions = requireOptions(adapterFactoryOptions, "Adapter factory options");
    const options = requireOptions(lazyOptions, "Adapter options");
    const txAdapter = createAdapterFactory({
      config: {
        ...currentFactoryOptions.config,
        transaction: false,
      },
      adapter: createCustomAdapter(tx),
    })(options);

    try {
      const result = await callback(txAdapter);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.cancel();
      } catch {
        // Ignore cancellation failures and preserve the original failure.
      }
      throw error;
    }
  };

  const enableTransactions = supportsTransactions();

  adapterFactoryOptions = {
    config: {
      adapterId: "surrealdb",
      adapterName: "SurrealDB Adapter",
      usePlural: config.usePlural ?? false,
      debugLogs: config.debugLogs ?? false,
      supportsJSON: true,
      supportsArrays: true,
      supportsDates: true,
      supportsBooleans: true,
      disableIdGeneration: true,
      customTransformInput: ({ data, field, fieldAttributes, model, schema, action }) => {
        if (data === undefined || data === null) return data;

        const typedSchema = schema as AdapterSchema;
        const defaultField = resolveDefaultFieldName(typedSchema, model, field);
        if (action === "create" && defaultField === "id") {
          throw adapterError(
            `forceAllowId is not supported for model "${model}". Let SurrealDB generate the record id.`,
          );
        }

        if (fieldAttributes.type === "date" && data instanceof Date) {
          return new DateTime(data);
        }

        if (defaultField === "id") {
          return toRecordIdInput(data, model);
        }

        if (fieldAttributes.references?.field === "id") {
          const targetModel = typedSchema[fieldAttributes.references.model]?.modelName;
          if (!targetModel) return data;
          return toRecordIdInput(data, targetModel);
        }

        return data;
      },
      customTransformOutput: ({ data, field, fieldAttributes, model, schema }) => {
        if (data === undefined || data === null) return data;

        if (fieldAttributes.type === "date") {
          return normalizeDateValue(data);
        }

        const typedSchema = schema as AdapterSchema;
        const defaultField = resolveDefaultFieldName(typedSchema, model, field);
        const isIdLikeField = defaultField === "id" || fieldAttributes.references?.field === "id";
        if (!isIdLikeField) return data;

        return normalizeRecordIdValue(data);
      },
      transaction: enableTransactions ? createTransactionRunner() : false,
    },
    adapter: createCustomAdapter(client),
  };

  const adapter = createAdapterFactory(adapterFactoryOptions);
  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    lazyOptions = options;
    return adapter(options);
  };
};
