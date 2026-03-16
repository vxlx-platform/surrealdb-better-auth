import type { BetterAuthOptions } from "@better-auth/core";
import type {
  AdapterFactoryOptions,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterDebugLogOption,
  Where,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import type { BoundQuery, Expr, Surreal } from "surrealdb";
import {
  DateTime,
  Features,
  RecordId,
  StringRecordId,
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
} from "surrealdb";

type SurrealClient = Pick<Surreal, "query" | "beginTransaction" | "isFeatureSupported">;
type SurrealQueryClient = Pick<SurrealClient, "query">;
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

/**
 * Better Auth adapter for SurrealDB.
 *
 * Contract:
 * - IDs returned to Better Auth are full string record ids (`table:id`).
 * - ID/reference inputs must be full record ids (or SDK RecordId/StringRecordId).
 */
export const surrealAdapter = (client: SurrealClient, config: SurrealAdapterConfig = {}) => {
  let lazyOptions: BetterAuthOptions | null = null;
  let adapterFactoryOptions!: AdapterFactoryOptions;

  const adapterError = (message: string, cause?: unknown) =>
    new Error(`[surrealdb-adapter] ${message}`, cause === undefined ? undefined : { cause });

  const toResultRows = <T>(result: QueryRows<T>): T[] => {
    if (result.length === 0) return [];
    if (result.length === 1 && Array.isArray(result[0])) {
      return result[0];
    }
    return result.filter((value): value is T => !Array.isArray(value));
  };

  const toFirstRow = <T>(result: QueryRows<T>): T | null => {
    const rows = toResultRows<T>(result);
    return rows[0] ?? null;
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
    if (raw !== "native" && raw !== "uuidv7" && raw !== "ulid") {
      throw adapterError(
        `Unsupported recordIdFormat "${String(raw)}". Supported values are "native", "uuidv7", and "ulid".`,
      );
    }
    return raw;
  };

  const createTargetExpression = (table: string, format: RecordIdFormat) => {
    const escapedTable = escapeIdent(table);
    if (format === "uuidv7") return `${escapedTable}:uuid()`;
    if (format === "ulid") return `${escapedTable}:ulid()`;
    return escapedTable;
  };

  const omitUndefinedFields = <T extends Record<string, unknown>>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

  const toObjectRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw adapterError(`Expected ${label} to be a plain object.`);
    }
    return value as Record<string, unknown>;
  };

  const fieldTypeMap = {
    string: "string",
    number: "number",
    boolean: "bool",
    date: "datetime",
    json: "object",
    "string[]": "array<string>",
    "number[]": "array<number>",
  } as const;

  type SupportedSchemaFieldType = keyof typeof fieldTypeMap;

  const isSupportedSchemaFieldType = (
    fieldType: SchemaField["type"],
  ): fieldType is SupportedSchemaFieldType =>
    typeof fieldType === "string" && fieldType in fieldTypeMap;

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
    return fieldTypeMap[fieldType];
  };

  const schemaFieldLookupCache = new WeakMap<AdapterSchema, Map<string, ModelFieldLookup>>();

  const getSchemaFieldLookup = (schema: AdapterSchema): Map<string, ModelFieldLookup> => {
    const cached = schemaFieldLookupCache.get(schema);
    if (cached) return cached;

    const lookup = new Map<string, ModelFieldLookup>();
    for (const table of Object.values(schema)) {
      const modelLookup: ModelFieldLookup = new Map();
      for (const [name, attributes] of Object.entries(table.fields)) {
        modelLookup.set(attributes.fieldName ?? name, name);
      }
      lookup.set(table.modelName, modelLookup);
    }

    schemaFieldLookupCache.set(schema, lookup);
    return lookup;
  };

  const resolveDefaultFieldName = (schema: AdapterSchema, model: string, field: string) =>
    getSchemaFieldLookup(schema).get(model)?.get(field) ?? field;

  const normalizeDateValue = (value: unknown) => {
    const isDateTimeLike = (
      candidate: unknown,
    ): candidate is { constructor: { name?: string }; toString: () => string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "constructor" in candidate &&
      typeof candidate.toString === "function" &&
      candidate.constructor?.name === "DateTime";

    if (value instanceof Date || value === null || value === undefined) return value;
    if (value instanceof DateTime) return value.toDate();
    if (isDateTimeLike(value)) {
      return new Date(value.toString());
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    return value;
  };

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

  const expectStringValue = (value: unknown, operator: "starts_with" | "ends_with"): string => {
    if (typeof value === "string") return value;
    throw adapterError(`Operator "${operator}" requires a string value.`);
  };

  const expectArrayValue = (value: unknown, operator: "in" | "not_in"): unknown[] => {
    if (Array.isArray(value)) return value;
    throw adapterError(`Operator "${operator}" requires an array value.`);
  };

  const formatUnknown = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "symbol") return value.description ?? "symbol";
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  };

  const resolveWhereOperator = (value: unknown): SupportedWhereOperator => {
    if (value === undefined) return "eq";
    if (value === "eq") return "eq";
    if (value === "ne") return "ne";
    if (value === "lt") return "lt";
    if (value === "lte") return "lte";
    if (value === "gt") return "gt";
    if (value === "gte") return "gte";
    if (value === "in") return "in";
    if (value === "not_in") return "not_in";
    if (value === "contains") return "contains";
    if (value === "starts_with") return "starts_with";
    if (value === "ends_with") return "ends_with";
    throw adapterError(`Unsupported where operator "${formatUnknown(value)}".`);
  };

  const whereOperatorExpr = (
    operator: SupportedWhereOperator,
    field: string,
    value: unknown,
  ): Expr => {
    if (operator === "eq") return eq(field, value);
    if (operator === "ne") return ne(field, value);
    if (operator === "lt") return lt(field, value);
    if (operator === "lte") return lte(field, value);
    if (operator === "gt") return gt(field, value);
    if (operator === "gte") return gte(field, value);
    if (operator === "contains") return contains(field, value);
    if (operator === "in") return inside(field, expectArrayValue(value, "in"));
    if (operator === "not_in") return not(inside(field, expectArrayValue(value, "not_in")));
    if (operator === "starts_with")
      return startsWithExpr(field, expectStringValue(value, "starts_with"));
    return endsWithExpr(field, expectStringValue(value, "ends_with"));
  };

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
    const lines: string[] = [];
    type SchemaTable = (typeof tables)[string];

    const buildIndexName = (tableName: string, fieldName: string): string => {
      const normalizedTable = tableName.replace(/`/g, "").toLowerCase();
      const normalizedField = fieldName.replace(/`/g, "");
      const capitalizedField = normalizedField
        ? normalizedField.charAt(0).toUpperCase() + normalizedField.slice(1)
        : "";
      return `${normalizedTable}${capitalizedField}_idx`;
    };

    const emitUniqueIndex = (tableName: string, resolvedField: string) => {
      const indexName = buildIndexName(tableName, resolvedField);
      lines.push(
        `DEFINE INDEX OVERWRITE ${escapeIdent(indexName)} ON TABLE ${tableName} COLUMNS ${resolvedField} UNIQUE;`,
      );
    };

    const emitFieldDefinition = ({
      modelName,
      tableName,
      fieldKey,
      field,
    }: {
      modelName: string;
      tableName: string;
      fieldKey: string;
      field: SchemaTable["fields"][string];
    }) => {
      const dbFieldName = field.fieldName ?? fieldKey;
      if (dbFieldName === "id") return;

      const resolvedField = escapeIdent(getFieldName({ model: modelName, field: dbFieldName }));
      const fieldType = field.references
        ? `record<${escapeIdent(getModelName(field.references.model))}>`
        : resolveSchemaType(modelName, dbFieldName, field.type);
      const requiredType = field.required ? fieldType : `option<${fieldType}>`;
      lines.push(
        `DEFINE FIELD OVERWRITE ${resolvedField} ON TABLE ${tableName} TYPE ${requiredType};`,
      );

      if (field.unique) emitUniqueIndex(tableName, resolvedField);
    };

    const emitTableDefinition = (table: SchemaTable) => {
      const modelName = table.modelName;
      const tableName = escapeIdent(getModelName(modelName));
      lines.push(`DEFINE TABLE OVERWRITE ${tableName} SCHEMAFULL;`);

      for (const [fieldKey, field] of Object.entries(table.fields)) {
        emitFieldDefinition({
          modelName,
          tableName,
          fieldKey,
          field,
        });
      }

      lines.push("");
    };

    for (const table of Object.values(tables)) {
      emitTableDefinition(table);
    }

    const renderAccessStatement = () => {
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
    };

    const accessStatement = renderAccessStatement();
    if (accessStatement) {
      lines.push(accessStatement.endsWith(";") ? accessStatement : `${accessStatement};`, "");
    }

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

  const buildWhereClause = (
    where: Where[] | undefined,
    model: string,
    tableName: string,
    idFieldName: string,
    resolveFieldName: (model: string, field: string) => string,
  ): { clause: string; bindings: Record<string, unknown> } => {
    if (!where?.length) return { clause: "", bindings: {} };

    const toConditionExpr = (item: Where): Expr => {
      const dbFieldName = resolveFieldName(model, item.field);
      const field = escapeIdent(dbFieldName);
      const operator = resolveWhereOperator(item.operator);

      const expectedReferenceTable = dbFieldName === idFieldName ? tableName : undefined;
      const normalizedValue =
        dbFieldName === idFieldName
          ? toRecordIdInput(item.value, expectedReferenceTable)
          : item.value;

      return whereOperatorExpr(operator, field, normalizedValue);
    };

    let condition = toConditionExpr(where[0]!);
    for (let index = 1; index < where.length; index += 1) {
      const connector = where[index]?.connector === "OR" ? "OR" : "AND";
      const next = toConditionExpr(where[index]!);
      condition = connector === "OR" ? or(condition, next) : and(condition, next);
    }

    const whereExpr = expr(condition);
    return {
      clause: whereExpr.query ? `WHERE ${whereExpr.query}` : "",
      bindings: whereExpr.bindings,
    };
  };

  const createCustomAdapter =
    (db: SurrealQueryClient) =>
    ({
      getFieldName,
      getModelName,
    }: Parameters<NonNullable<AdapterFactoryOptions["adapter"]>>[0]) => {
      const resolveTableName = (model: string) => getModelName(model);
      const resolveFieldName = (model: string, field: string) => {
        try {
          return getFieldName({ model, field });
        } catch {
          return field;
        }
      };

      const queryRows = async <T>(query: string, bindings: Record<string, unknown>) =>
        toResultRows<T>(await db.query<QueryRows<T>>(query, bindings));

      const queryFirst = async <T>(query: string, bindings: Record<string, unknown>) =>
        (await queryRows<T>(query, bindings))[0] ?? null;

      const selectColumns = (model: string, select?: string[]) =>
        select && select.length > 0
          ? select.map((field) => escapeIdent(resolveFieldName(model, field))).join(", ")
          : "*";

      const joinQueryParts = (...parts: Array<string | undefined>) =>
        parts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" ");

      const splitUpdatePayload = (update: Record<string, unknown>) => {
        const nonNullEntries: Array<[string, unknown]> = [];
        const noneFields: string[] = [];

        for (const [field, value] of Object.entries(update)) {
          if (value === undefined) continue;
          if (value === null) {
            noneFields.push(field);
            continue;
          }
          nonNullEntries.push([field, value]);
        }

        return {
          nonNullUpdate: Object.fromEntries(nonNullEntries) as Record<string, unknown>,
          noneFields,
        };
      };

      const mapWritePayload = (model: string, payload: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(payload).map(([field, value]) => [resolveFieldName(model, field), value]),
        ) as Record<string, unknown>;

      const splitMappedUpdatePayload = (model: string, update: Record<string, unknown>) =>
        splitUpdatePayload(mapWritePayload(model, update));

      const buildNoneSetClause = (fields: string[]) =>
        fields.map((field) => `${escapeIdent(field)} = NONE`).join(", ");

      const buildSelectQuery = ({
        columns,
        tableName,
        whereClause,
        orderBy,
        limitClause,
        offsetClause,
      }: {
        columns: string;
        tableName: string;
        whereClause: string;
        orderBy?: string;
        limitClause?: string;
        offsetClause?: string;
      }) =>
        `${joinQueryParts(
          `SELECT ${columns}`,
          `FROM ${tableName}`,
          whereClause,
          orderBy,
          limitClause,
          offsetClause,
        )};`;

      const idFieldForModel = (model: string) => resolveFieldName(model, "id");

      const resolveModelQueryContext = (model: string, where?: CleanedWhere[]) => {
        const resolvedTableName = resolveTableName(model);
        const tableName = escapeIdent(resolvedTableName);
        const idField = idFieldForModel(model);
        const whereClause = buildWhereClause(
          where,
          model,
          resolvedTableName,
          idField,
          resolveFieldName,
        );
        return { resolvedTableName, tableName, idField, whereClause };
      };

      const resolveSingleRecordId = async (model: string, where: Where[]) => {
        const { resolvedTableName, tableName, idField } = resolveModelQueryContext(model);
        const fastPath =
          where.length === 1 &&
          resolveFieldName(model, String(where[0]?.field ?? "")) === idField &&
          where[0]?.operator === "eq";
        if (fastPath) {
          return toStringRecordId(where[0]!.value, resolvedTableName);
        }

        const whereClause = buildWhereClause(
          where,
          model,
          resolvedTableName,
          idField,
          resolveFieldName,
        );
        const query = `SELECT VALUE ${escapeIdent(idField)} FROM ${tableName} ${whereClause.clause} LIMIT 1;`;
        const rows = await db.query<QueryRows<StringRecordId | RecordId | string>>(
          query,
          whereClause.bindings,
        );
        const first = toFirstRow(rows);
        if (!first) return null;
        return toStringRecordId(first, resolvedTableName);
      };

      const countRecords = async (model: string, where?: CleanedWhere[]) => {
        const { tableName, whereClause } = resolveModelQueryContext(model, where);
        const query = `SELECT count() AS total FROM ${tableName} ${whereClause.clause} GROUP ALL;`;
        const row = await queryFirst<{ total: number }>(query, whereClause.bindings);
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
          const explicitIdField = idFieldForModel(model);
          const explicitId = data[explicitIdField] ?? data.id;
          const table = resolveTableName(model);

          if (explicitId !== undefined && explicitId !== null) {
            throw adapterError(
              `Explicit ids are not supported for model "${model}". Let SurrealDB generate the record id.`,
            );
          }

          const format = resolveRecordIdFormat(config.recordIdFormat, table);
          const targetExpression = createTargetExpression(table, format);
          const createData = omitUndefinedFields(
            mapWritePayload(model, data as Record<string, unknown>),
          );
          const query = `CREATE ONLY ${targetExpression} CONTENT $data RETURN AFTER;`;
          const created = await queryFirst<T>(query, {
            data: createData,
          });
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
          const { tableName, whereClause } = resolveModelQueryContext(model, where);
          const columns = selectColumns(model, select);
          const query = buildSelectQuery({
            columns,
            tableName,
            whereClause: whereClause.clause,
            limitClause: "LIMIT 1",
          });
          return await queryFirst<T>(query, whereClause.bindings);
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
          const { tableName, whereClause } = resolveModelQueryContext(model, where);
          const columns = selectColumns(model, select);
          const bindings: Record<string, unknown> = { ...whereClause.bindings };
          const orderBy = sortBy
            ? `ORDER BY ${escapeIdent(resolveFieldName(model, sortBy.field))} ${sortBy.direction.toUpperCase()}`
            : undefined;
          const limitClause = typeof limit === "number" ? "LIMIT $limit" : undefined;
          const offsetClause = typeof offset === "number" ? "START $offset" : undefined;

          if (typeof limit === "number") bindings.limit = limit;
          if (typeof offset === "number") bindings.offset = offset;

          const query = buildSelectQuery({
            columns,
            tableName,
            whereClause: whereClause.clause,
            orderBy,
            limitClause,
            offsetClause,
          });
          return await queryRows<T>(query, bindings);
        },

        async count({
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
          const target = await resolveSingleRecordId(model, where);
          if (!target) return null;
          const updateData = toObjectRecord(update, `update payload for "${model}"`);
          const { nonNullUpdate, noneFields } = splitMappedUpdatePayload(model, updateData);

          if (Object.keys(nonNullUpdate).length > 0) {
            await db.query("UPDATE $target MERGE $update;", {
              target,
              update: nonNullUpdate,
            });
          }
          if (noneFields.length > 0) {
            const noneClause = buildNoneSetClause(noneFields);
            await db.query(`UPDATE $target SET ${noneClause};`, { target });
          }

          return await queryFirst<T>("SELECT * FROM ONLY $target;", { target });
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
          return withCountBeforeMutation(model, where, async ({ tableName, whereClause }) => {
            const { nonNullUpdate, noneFields } = splitMappedUpdatePayload(model, update);

            if (Object.keys(nonNullUpdate).length > 0) {
              const mergeQuery = `UPDATE ${tableName} MERGE $update ${whereClause.clause};`;
              await db.query(mergeQuery, {
                ...whereClause.bindings,
                update: nonNullUpdate,
              });
            }
            if (noneFields.length > 0) {
              const noneClause = buildNoneSetClause(noneFields);
              const setQuery = `UPDATE ${tableName} SET ${noneClause} ${whereClause.clause};`;
              await db.query(setQuery, whereClause.bindings);
            }
          });
        },

        async delete({ model, where }: { model: string; where: CleanedWhere[] }): Promise<void> {
          const target = await resolveSingleRecordId(model, where);
          if (!target) return;
          await db.query("DELETE $target;", { target });
        },

        async deleteMany({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }): Promise<number> {
          return withCountBeforeMutation(model, where, async ({ tableName, whereClause }) => {
            const query = `DELETE ${tableName} ${whereClause.clause};`;
            await db.query(query, whereClause.bindings);
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
    const txAdapter = createAdapterFactory({
      config: {
        ...adapterFactoryOptions!.config,
        transaction: false,
      },
      adapter: createCustomAdapter(tx),
    })(lazyOptions!);

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
