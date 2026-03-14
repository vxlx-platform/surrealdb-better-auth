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
import type { Expr, Surreal } from "surrealdb";
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
  apiEndpoints?: boolean | SchemaApiEndpointsConfig;
}

export interface SchemaApiEndpointsConfig {
  basePath?: string;
  models?: string[];
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
type TransactionRunner = Exclude<NonNullable<AdapterFactoryOptions["config"]["transaction"]>, false>;

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
    if (format === "uuidv7") return `type::thing(${JSON.stringify(table)}, rand::uuid())`;
    if (format === "ulid") return `type::thing(${JSON.stringify(table)}, rand::ulid())`;
    return escapeIdent(table);
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
  ] as const;

  type SupportedWhereOperator = (typeof supportedWhereOperators)[number];
  const supportedWhereOperatorSet: ReadonlySet<string> = new Set(supportedWhereOperators);

  const isSupportedWhereOperator = (value: unknown): value is SupportedWhereOperator =>
    typeof value === "string" && supportedWhereOperatorSet.has(value);

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
    if (isSupportedWhereOperator(value)) return value;
    throw adapterError(`Unsupported where operator "${formatUnknown(value)}".`);
  };

  const whereOperatorHandlers: Record<
    SupportedWhereOperator,
    (field: string, value: unknown) => Expr
  > = {
    eq: (field, value) => eq(field, value),
    ne: (field, value) => ne(field, value),
    lt: (field, value) => lt(field, value),
    lte: (field, value) => lte(field, value),
    gt: (field, value) => gt(field, value),
    gte: (field, value) => gte(field, value),
    contains: (field, value) => contains(field, value),
    in: (field, value) => inside(field, expectArrayValue(value, "in")),
    not_in: (field, value) => not(inside(field, expectArrayValue(value, "not_in"))),
    starts_with: (field, value) => startsWithExpr(field, expectStringValue(value, "starts_with")),
    ends_with: (field, value) => endsWithExpr(field, expectStringValue(value, "ends_with")),
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
    const apiCfg =
      config.apiEndpoints === true
        ? {}
        : config.apiEndpoints && typeof config.apiEndpoints === "object"
          ? config.apiEndpoints
          : null;
    const apiModels = new Set(
      apiCfg?.models?.length ? apiCfg.models : ["user", "session", "account"],
    );
    const apiBasePath = apiCfg?.basePath ? `/${apiCfg.basePath.replace(/^\/+|\/+$/g, "")}` : "";
    const apiTables: string[] = [];
    type SchemaTable = (typeof tables)[string];

    const emitUniqueIndex = (tableName: string, resolvedField: string) => {
      const indexName = `${tableName.replace(/`/g, "")}${resolvedField.replace(/`/g, "")}_idx`;
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
      lines.push(`DEFINE FIELD OVERWRITE ${resolvedField} ON TABLE ${tableName} TYPE ${requiredType};`);

      if (field.unique) emitUniqueIndex(tableName, resolvedField);
    };

    const emitTableDefinition = (table: SchemaTable) => {
      const modelName = table.modelName;
      const tableName = escapeIdent(getModelName(modelName));
      lines.push(`DEFINE TABLE OVERWRITE ${tableName} SCHEMAFULL;`);

      if (apiCfg && apiModels.has(modelName)) {
        apiTables.push(getModelName(modelName));
      }

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

    const emitApiEndpoint = (tableName: string) => {
      const escapedTable = escapeIdent(tableName);
      const path = `${apiBasePath}/${tableName}`;
      lines.push(
        `DEFINE API OVERWRITE "${path}"`,
        "  FOR get",
        "  MIDDLEWARE",
        '    api::res::body("json")',
        "  THEN {",
        "    {",
        "      status: 200,",
        `      body: SELECT * FROM ${escapedTable}`,
        "    }",
        "  }",
        ";",
        "",
      );
    };

    for (const table of Object.values(tables)) {
      emitTableDefinition(table);
    }

    if (apiCfg) {
      for (const tableName of apiTables) {
        emitApiEndpoint(tableName);
      }
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
    idFieldName: string,
  ): { clause: string; bindings: Record<string, unknown> } => {
    if (!where?.length) return { clause: "", bindings: {} };

    const toConditionExpr = (item: Where): Expr => {
      const field = escapeIdent(item.field);
      const operator = resolveWhereOperator(item.operator);

      const expectedReferenceTable = item.field === idFieldName ? model : undefined;
      const normalizedValue =
        item.field === idFieldName
          ? toRecordIdInput(item.value, expectedReferenceTable)
          : item.value;

      return whereOperatorHandlers[operator](field, normalizedValue);
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
      const queryOne = async <T>(
        query: string,
        bindings: Record<string, unknown>,
      ) => {
        const result = await db.query<QueryRows<T>>(query, bindings);
        return toFirstRow<T>(result);
      };

      const queryMany = async <T>(
        query: string,
        bindings: Record<string, unknown>,
      ) => {
        const result = await db.query<QueryRows<T>>(query, bindings);
        return toResultRows<T>(result);
      };

      const selectColumns = (select?: string[]) =>
        select && select.length > 0 ? select.map((field) => escapeIdent(field)).join(", ") : "*";

      const joinQueryParts = (...parts: Array<string | undefined>) =>
        parts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" ");

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

      const idFieldForModel = (model: string) => getFieldName({ model, field: "id" });

      const resolveSingleRecordId = async (model: string, where: Where[]) => {
        const idField = idFieldForModel(model);
        const fastPath =
          where.length === 1 && where[0]?.field === idField && where[0].operator === "eq";
        if (fastPath) {
          return toStringRecordId(where[0]!.value, model);
        }

        const tableName = escapeIdent(model);
        const whereClause = buildWhereClause(where, model, idField);
        const query = `SELECT VALUE ${escapeIdent(idField)} FROM ${tableName} ${whereClause.clause} LIMIT 1;`;
        const rows = await db.query<QueryRows<StringRecordId | RecordId | string>>(
          query,
          whereClause.bindings,
        );
        const first = toFirstRow(rows);
        if (!first) return null;
        return toStringRecordId(first, model);
      };

      const countRecords = async (model: string, where?: CleanedWhere[]) => {
        const tableName = escapeIdent(model);
        const idField = idFieldForModel(model);
        const whereClause = buildWhereClause(where, model, idField);
        const query = `SELECT count() AS total FROM ${tableName} ${whereClause.clause} GROUP ALL;`;
        const row = await queryOne<{ total: number }>(query, whereClause.bindings);
        return Number(row?.total ?? 0);
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
          const explicitId = data[explicitIdField];
          const table = model;

          if (explicitId !== undefined && explicitId !== null) {
            throw adapterError(
              `Explicit ids are not supported for model "${table}". Let SurrealDB generate the record id.`,
            );
          }

          const format = resolveRecordIdFormat(config.recordIdFormat, table);
          const targetExpression = createTargetExpression(table, format);
          const createData = omitUndefinedFields(data);
          const query = `CREATE ONLY ${targetExpression} CONTENT $data RETURN AFTER;`;
          const created = await queryOne<T>(query, {
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
          const tableName = escapeIdent(model);
          const idField = idFieldForModel(model);
          const columns = selectColumns(select);
          const whereClause = buildWhereClause(where, model, idField);
          const query = buildSelectQuery({
            columns,
            tableName,
            whereClause: whereClause.clause,
            limitClause: "LIMIT 1",
          });
          return await queryOne<T>(query, whereClause.bindings);
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
          const tableName = escapeIdent(model);
          const idField = idFieldForModel(model);
          const columns = selectColumns(select);
          const whereClause = buildWhereClause(where, model, idField);
          const bindings: Record<string, unknown> = { ...whereClause.bindings };
          const orderBy = sortBy
            ? `ORDER BY ${escapeIdent(sortBy.field)} ${sortBy.direction.toUpperCase()}`
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
          return await queryMany<T>(query, bindings);
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
          const updateData = omitUndefinedFields(toObjectRecord(update, `update payload for "${model}"`));
          const query = "UPDATE $target MERGE $update RETURN AFTER;";
          return await queryOne<T>(query, {
            target,
            update: updateData,
          });
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
          const idField = idFieldForModel(model);
          const countBefore = await countRecords(model, where);
          if (countBefore === 0) return 0;

          const tableName = escapeIdent(model);
          const whereClause = buildWhereClause(where, model, idField);
          const updateData = omitUndefinedFields(update);
          const query = `UPDATE ${tableName} MERGE $update ${whereClause.clause};`;
          await db.query(query, {
            ...whereClause.bindings,
            update: updateData,
          });
          return countBefore;
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
          const idField = idFieldForModel(model);
          const countBefore = await countRecords(model, where);
          if (countBefore === 0) return 0;

          const tableName = escapeIdent(model);
          const whereClause = buildWhereClause(where, model, idField);
          const query = `DELETE ${tableName} ${whereClause.clause};`;
          await db.query(query, whereClause.bindings);
          return countBefore;
        },

        async createSchema({ file, tables }: { file?: string | undefined; tables: BetterAuthDBSchema }) {
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
