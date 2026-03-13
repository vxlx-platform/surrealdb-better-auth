import type { BetterAuthDBSchema, BetterAuthOptions } from "better-auth";
import type {
  AdapterFactoryCustomizeAdapterCreator,
  AdapterFactoryOptions,
  DBAdapterDebugLogOption,
  DBTransactionAdapter,
  Where,
} from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";
import type { Expr, ExprLike, Surreal, SurrealQueryable } from "surrealdb";
import {
  BoundQuery,
  DateTime,
  RecordId,
  StringRecordId,
  Table,
  Uuid,
  and,
  contains,
  eq,
  escapeIdent,
  expr,
  gt,
  gte,
  lt,
  lte,
  ne,
  or,
  surql,
} from "surrealdb";

import { createQueryErrorWrapper } from "./internal/errors";
import { createIdHelpers } from "./internal/id";
import {
  createTransactionExecutor,
  detectTransactionFeatureSupport,
} from "./internal/transactions";

/** Internal/test-only config for optional DEFINE API generation in schema output. */
type SurrealApiEndpointsConfig = { basePath?: string; models?: string[] };
/** Adapter factory helper bag passed by Better Auth. */
type Helpers = Parameters<AdapterFactoryCustomizeAdapterCreator>[0];
/** Query target can be a table, a single record id, or a list of record ids. */
type QueryTarget = Table | RecordId | RecordId[];
/** Standard row response shape for Surreal SDK query results. */
type QueryRows<T> = [T[]];
type ModelFieldContext = {
  dbFieldName: string;
  fieldAttributes: ReturnType<Helpers["getFieldAttributes"]>;
};

export const surrealAdapter = (
  db: Surreal,
  config?: {
    usePlural?: boolean;
    debugLogs?: DBAdapterDebugLogOption;
    recordIdFormat?:
      | "native"
      | "ulid"
      | "uuidv7"
      | ((tableName: string) => "native" | "ulid" | "uuidv7");
    transaction?: "auto" | boolean;
  },
) => {
  type InternalConfig = NonNullable<typeof config> & {
    apiEndpoints?: boolean | SurrealApiEndpointsConfig;
  };
  const internalConfig = config as InternalConfig | undefined;
  const transactionMode = config?.transaction ?? "auto";
  const hasForkSessionMethod = typeof db.forkSession === "function";
  const initialTransactionSupport = detectTransactionFeatureSupport(db);

  /** Creates adapter-scoped errors with a stable prefix and optional cause. */
  const adapterError = (message: string, cause?: unknown) => {
    const error = new Error(`[surrealdb-adapter] ${message}`);
    if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
    return error;
  };
  const wrapQueryError = createQueryErrorWrapper(adapterError);

  /** Executes bound/string Surreal queries against the selected query client. */
  const executeQuery = <T extends unknown[]>(
    client: Pick<SurrealQueryable, "query">,
    query: string | BoundQuery<T>,
  ): Promise<T> => {
    if (typeof query === "string") return client.query<T>(query) as Promise<T>;
    return client.query<T>(query) as Promise<T>;
  };

  /** Resolves how record ids should be generated for a table. */
  const resolveIdFormat = (tableName: string): "native" | "ulid" | "uuidv7" => {
    const fmt = config?.recordIdFormat;
    const resolved = typeof fmt === "function" ? fmt(tableName) : (fmt ?? "native");
    if (resolved === "native" || resolved === "ulid" || resolved === "uuidv7") return resolved;
    throw adapterError(
      `Unsupported recordIdFormat "${String(resolved)}" for table "${tableName}". Use "native", "ulid", or "uuidv7".`,
    );
  };

  const { normalizeReferenceInput, stripRecordPrefix, toRecordId } = createIdHelpers({
    resolveIdFormat,
    adapterError,
  });

  const createCustomAdapter =
    (client: Pick<SurrealQueryable, "query">): AdapterFactoryCustomizeAdapterCreator =>
    ({ getModelName, getFieldName, getFieldAttributes }: Helpers) => {
      const fieldCache = new Map<string, ModelFieldContext>();
      const resolveModelName = (model: string) => getModelName(model);

      /** Resolves and caches model-field metadata from Better Auth mapping helpers. */
      const resolveFieldContext = (model: string, field: string): ModelFieldContext => {
        const key = `${model}:${field}`;
        const cached = fieldCache.get(key);
        if (cached) return cached;
        try {
          const resolved = {
            dbFieldName: getFieldName({ field, model }),
            fieldAttributes: getFieldAttributes({ field, model }),
          };
          fieldCache.set(key, resolved);
          return resolved;
        } catch (error) {
          throw adapterError(
            `Field "${field}" is not defined for model "${model}". Check your Better Auth schema and adapter usage.`,
            error,
          );
        }
      };

      const assertWritePayload = (model: string, input: Record<string, unknown>) => {
        for (const key of Object.keys(input)) {
          if (key !== "id") resolveFieldContext(model, key);
        }
      };

      const safeConnector = (connector?: string): "AND" | "OR" =>
        connector?.toUpperCase() === "OR" ? "OR" : "AND";

      const stripIdFromPayload = <T extends Record<string, unknown>>(input: T): Omit<T, "id"> => {
        const { id: _id, ...rest } = input;
        return rest;
      };

      const normalizeNullToNone = (val: unknown): unknown => {
        if (val === null) return undefined;
        if (Array.isArray(val)) return val.map(normalizeNullToNone);
        if (
          val &&
          typeof val === "object" &&
          !(
            val instanceof RecordId ||
            val instanceof StringRecordId ||
            val instanceof Uuid ||
            val instanceof Date ||
            val instanceof Uint8Array
          )
        ) {
          const proto = Object.getPrototypeOf(val);
          if (proto === null || proto === Object.prototype || proto.constructor.name === "Object") {
            return Object.fromEntries(
              Object.entries(val).map(([key, val]) => [key, normalizeNullToNone(val)]),
            );
          }
        }
        return val;
      };

      /**
       * Optimizes id-only where clauses by targeting specific record ids
       * instead of always querying the full table.
       */
      const splitIdWhere = (
        table: string,
        where?: Where[],
      ): { target: QueryTarget; rest: Where[] } => {
        const fallback = { target: new Table(table), rest: where ?? [] };
        if (
          !where?.length ||
          where.some((whereItem, index) => index > 0 && safeConnector(whereItem.connector) === "OR")
        ) {
          return fallback;
        }

        const ids: RecordId[] = [];
        const rest: Where[] = [];

        for (const whereItem of where) {
          const op = (whereItem.operator ?? "eq").toLowerCase();
          const match =
            whereItem.field === "id" &&
            (op === "eq" ||
              (op === "in" && Array.isArray(whereItem.value) && whereItem.value.length));

          if (match) ids.push(...[whereItem.value].flat().map((val) => toRecordId(table, val)));
          else rest.push(whereItem);
        }

        return ids.length ? { target: ids.length === 1 ? ids[0]! : ids, rest } : fallback;
      };

      const customExpr = (toSQL: (ctx: { def: (value: unknown) => string }) => string): Expr =>
        ({ toSQL }) as Expr;

      /** Builds a typed Surreal expression for one Better Auth where condition. */
      const buildCondition = (model: string, where: Where): ExprLike => {
        const { dbFieldName, fieldAttributes } = resolveFieldContext(model, where.field);
        const operator = (where.operator ?? "eq").toLowerCase();
        let value: unknown = where.value;
        if (operator === "in" && !Array.isArray(value)) {
          throw adapterError(
            `Operator "in" requires an array value for field "${where.field}" on model "${model}".`,
          );
        }
        if (fieldAttributes?.references) {
          const refTable = fieldAttributes.references.model;
          const ctx = { model, field: where.field, operator };
          value =
            operator === "in" && Array.isArray(value)
              ? value.map((val) => normalizeReferenceInput(refTable, val, ctx))
              : normalizeReferenceInput(refTable, value, ctx);
        }

        const ident = escapeIdent(dbFieldName);
        switch (operator) {
          case "eq":
            return eq(ident, value);
          case "ne":
            return ne(ident, value);
          case "lt":
            return lt(ident, value);
          case "lte":
            return lte(ident, value);
          case "gt":
            return gt(ident, value);
          case "gte":
            return gte(ident, value);
          case "contains":
            return contains(ident, value);
          case "in":
            return customExpr((ctx) => `${ident} IN ${ctx.def(value)}`);
          case "starts_with":
            return customExpr((ctx) => `string::starts_with(${ident}, ${ctx.def(value)})`);
          case "ends_with":
            return customExpr((ctx) => `string::ends_with(${ident}, ${ctx.def(value)})`);
          default:
            throw adapterError(
              `Unsupported operator "${operator}" for field "${where.field}" on model "${model}".`,
            );
        }
      };

      /** Folds Better Auth where arrays into a single Surreal expression tree. */
      const buildWhereExpr = (model: string, where?: Where[]): ExprLike | null => {
        if (!where?.length) return null;
        let clause: ExprLike = buildCondition(model, where[0]!);
        for (let i = 1; i < where.length; i++) {
          const condition = buildCondition(model, where[i]!);
          clause =
            safeConnector(where[i]!.connector) === "OR"
              ? or(clause, condition)
              : and(clause, condition);
        }
        return clause;
      };

      /** Appends a WHERE clause only when conditions are present. */
      const appendWhere = (query: BoundQuery, model: string, where?: Where[]) => {
        const clause = buildWhereExpr(model, where);
        if (!clause) return;
        query.append(" WHERE ");
        query.append(expr(clause));
      };

      /** Creates a query pre-targeted at table/record ids and returns remaining filters. */
      const prepareTargetQuery = (
        model: string,
        where: Where[] | undefined,
        sqlForTable: (table: string) => string,
        sqlForTarget: string,
      ): { tableName: string; query: BoundQuery; rest: Where[] } => {
        const tableName = resolveModelName(model);
        const { target, rest } = splitIdWhere(tableName, where);
        const query =
          target instanceof Table
            ? new BoundQuery(sqlForTable(tableName))
            : new BoundQuery(sqlForTarget, { target });
        return { tableName, query, rest };
      };

      /** Runs a row-returning query and shapes errors consistently. */
      const queryMany = async <T>(query: BoundQuery, context: string): Promise<T[]> => {
        try {
          const [rows] = await executeQuery<QueryRows<T>>(client, query);
          return rows ?? [];
        } catch (error) {
          return wrapQueryError(error, context);
        }
      };

      const queryOne = async <T>(query: BoundQuery, context: string): Promise<T | null> => {
        const rows = await queryMany<T>(query, context);
        return rows[0] ?? null;
      };

      /** Runs scalar Surreal queries like `RETURN array::len(...)`. */
      const queryScalar = async <T>(query: BoundQuery, context: string): Promise<T | null> => {
        try {
          const [value] = await executeQuery<[T]>(client, query);
          return value ?? null;
        } catch (error) {
          return wrapQueryError(error, context);
        }
      };

      return {
        options: config,
        count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `SELECT count() AS count FROM ${escapeIdent(tb)}`,
            "SELECT count() AS count FROM $target",
          );
          appendWhere(query, tableName, rest);
          query.append(" GROUP ALL");
          const rows = await queryMany<{ count: number }>(
            query,
            `counting records in "${tableName}"`,
          );
          return rows[0]?.count ?? 0;
        },
        create: async <T>({ model, data }: { model: string; data: T }): Promise<T> => {
          const tableName = resolveModelName(model);
          const payload = data as Record<string, unknown>;
          assertWritePayload(model, payload);
          const content = normalizeNullToNone(stripIdFromPayload(payload));
          const rawId = payload.id;

          const getTarget = () => {
            if (rawId != null) return "$rid";
            const fmt = resolveIdFormat(tableName);
            const suffix = fmt === "ulid" ? ":ulid()" : fmt === "uuidv7" ? ":uuid()" : "";
            return `${escapeIdent(tableName)}${suffix}`;
          };

          const query = new BoundQuery(`CREATE ${getTarget()} CONTENT $data`, {
            rid: rawId != null ? toRecordId(tableName, rawId) : undefined,
            data: content,
          });
          const created = await queryOne<T>(query, `creating a record in "${tableName}"`);
          if (!created) throw adapterError(`Failed to create record in "${tableName}".`);
          return created;
        },
        findOne: async <T>({
          model,
          where,
        }: {
          model: string;
          where: Where[];
        }): Promise<T | null> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
          );
          appendWhere(query, tableName, rest);
          query.append(" LIMIT 1");
          return queryOne<T>(query, `finding one record in "${tableName}"`);
        },
        findMany: async <T>({
          model,
          where,
          limit,
          offset,
          sortBy,
        }: {
          model: string;
          where?: Where[];
          limit?: number;
          offset?: number;
          sortBy?: { field: string; direction: "asc" | "desc" };
        }): Promise<T[]> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
          );
          appendWhere(query, tableName, rest);
          if (sortBy) {
            const sortField = escapeIdent(resolveFieldContext(model, sortBy.field).dbFieldName);
            query.append(` ORDER BY ${sortField} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`);
          }
          if (typeof limit === "number") query.append(surql` LIMIT ${limit}`);
          if (typeof offset === "number") query.append(surql` START ${offset}`);
          return queryMany<T>(query, `finding records in "${tableName}"`);
        },
        update: async <T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: Where[];
          update: T;
        }): Promise<T | null> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `UPDATE ${escapeIdent(tb)}`,
            "UPDATE $target",
          );
          const payload = update as Record<string, unknown>;
          assertWritePayload(model, payload);
          query.append(surql` MERGE ${normalizeNullToNone(stripIdFromPayload(payload))}`);
          appendWhere(query, tableName, rest);
          query.append(" RETURN AFTER");
          return queryOne<T>(query, `updating a record in "${tableName}"`);
        },
        updateMany: async ({
          model,
          update,
          where,
        }: {
          model: string;
          update: Record<string, unknown>;
          where: Where[];
        }): Promise<number> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `RETURN array::len((UPDATE ${escapeIdent(tb)}`,
            "RETURN array::len((UPDATE $target",
          );
          assertWritePayload(model, update);
          query.append(surql` MERGE ${normalizeNullToNone(stripIdFromPayload(update))}`);
          appendWhere(query, tableName, rest);
          query.append(" RETURN VALUE id))");
          return (await queryScalar<number>(query, `updating records in "${tableName}"`)) ?? 0;
        },
        delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `DELETE ${escapeIdent(tb)}`,
            "DELETE $target",
          );
          appendWhere(query, tableName, rest);
          try {
            await executeQuery(client, query);
          } catch (error) {
            wrapQueryError(error, `deleting records from "${tableName}"`);
          }
        },
        deleteMany: async ({
          model,
          where,
        }: {
          model: string;
          where: Where[];
        }): Promise<number> => {
          const { tableName, query, rest } = prepareTargetQuery(
            model,
            where,
            (tb) => `RETURN array::len((DELETE ${escapeIdent(tb)}`,
            "RETURN array::len((DELETE $target",
          );
          appendWhere(query, tableName, rest);
          query.append(" RETURN VALUE id))");
          return (await queryScalar<number>(query, `deleting records from "${tableName}"`)) ?? 0;
        },
        createSchema: async ({ file, tables }: { file?: string; tables: BetterAuthDBSchema }) => {
          const { generateSurqlSchema } = await import("./schema.js");
          return generateSurqlSchema({
            file,
            tables,
            getModelName,
            getFieldName,
            apiEndpoints: internalConfig?.apiEndpoints,
          });
        },
      };
    };

  let lazyOptions: BetterAuthOptions | null = null;

  /** Shared Better Auth adapter capability/config metadata. */
  const adapterConfigBase: Omit<AdapterFactoryOptions["config"], "transaction"> = {
    adapterId: "surrealdb-adapter",
    adapterName: "SurrealDB Adapter",
    usePlural: config?.usePlural ?? false,
    debugLogs: config?.debugLogs ?? false,
    supportsJSON: true,
    supportsDates: true,
    supportsBooleans: true,
    supportsNumericIds: false,
    disableIdGeneration: true,
    customTransformInput: ({ field, model, fieldAttributes, data }) =>
      fieldAttributes?.references
        ? normalizeReferenceInput(fieldAttributes.references.model, data, { model, field })
        : data,
    customTransformOutput: ({ field, data, fieldAttributes }) => {
      if (field === "id" || fieldAttributes?.references) return stripRecordPrefix(data);
      return data instanceof DateTime ? data.toDate() : data;
    },
  };

  const createRuntimeAdapter = (
    queryClient: Pick<SurrealQueryable, "query">,
    transaction: AdapterFactoryOptions["config"]["transaction"],
  ): DBTransactionAdapter =>
    createAdapterFactory({
      config: { ...adapterConfigBase, transaction },
      adapter: createCustomAdapter(queryClient),
    })(lazyOptions!);

  let noTxRuntimeAdapter: DBTransactionAdapter | null = null;
  /** Fallback path used when DB transactions are disabled/unsupported. */
  const runWithoutDatabaseTransaction = <R>(
    callback: (trx: DBTransactionAdapter) => Promise<R>,
  ): Promise<R> => {
    if (!noTxRuntimeAdapter) noTxRuntimeAdapter = createRuntimeAdapter(db, false);
    return callback(noTxRuntimeAdapter);
  };

  const transactionExecutor = createTransactionExecutor({
    db,
    transactionMode,
    initialTransactionSupport,
    hasForkSessionMethod,
    adapterError,
    createRuntimeAdapter,
    runWithoutDatabaseTransaction,
  });

  const baseFactory = createAdapterFactory({
    config: { ...adapterConfigBase, transaction: transactionExecutor },
    adapter: createCustomAdapter(db),
  });

  return (options: BetterAuthOptions) => {
    lazyOptions = options;
    return baseFactory(options);
  };
};
