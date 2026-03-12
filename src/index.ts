import { type BetterAuthDBSchema, type BetterAuthOptions } from "better-auth";
import {
  type AdapterFactoryCustomizeAdapterCreator,
  type AdapterFactoryOptions,
  type DBAdapterDebugLogOption,
  type DBTransactionAdapter,
  type Where,
  createAdapterFactory,
} from "better-auth/adapters";
import {
  BoundQuery,
  ConnectionUnavailableError,
  DateTime,
  type Expr,
  type ExprLike,
  Features,
  InvalidSessionError,
  MissingNamespaceDatabaseError,
  RecordId,
  ServerError,
  StringRecordId,
  type Surreal,
  SurrealError,
  type SurrealQueryable,
  type SurrealSession,
  Table,
  UnsupportedFeatureError,
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
  u,
} from "surrealdb";

/**
 * Supported SurrealDB record-id generation formats when Better Auth does not supply an id.
 *
 * - `native`: SurrealDB default random IDs (CREATE table CONTENT ...).
 * - `ulid`: SurrealDB ULID IDs (CREATE table:ulid() CONTENT ...).
 * - `uuidv7`: SurrealDB UUIDv7 IDs (CREATE table:uuid() CONTENT ...).
 */
export type RecordIdFormat = "native" | "ulid" | "uuidv7";

/**
 * Internal/test-only configuration for optional SurrealDB DEFINE API generation.
 *
 * This is kept primarily to support repository test coverage around generated
 * SurrealDB HTTP endpoints. It is not a recommended public adapter feature.
 */
interface SurrealApiEndpointsConfig {
  /**
   * Base path under `/api/:ns/:db`.
   *
   * For example, `/better-auth` generates:
   * - `/api/:ns/:db/better-auth/user`
   * - `/api/:ns/:db/better-auth/session`
   *
   * Defaults to no prefix, which generates top-level endpoints such as:
   * - `/api/:ns/:db/user`
   * - `/api/:ns/:db/session`
   */
  basePath?: string;

  /**
   * Which Better Auth models should get DEFINE API endpoints.
   *
   * Defaults to `user`, `session`, `account`, and `jwks`.
   */
  models?: string[];
}

/**
 * Configuration options for the SurrealDB Better Auth adapter.
 */
export interface SurrealAdapterConfig {
  /**
   * Whether Better Auth model names should be pluralized.
   */
  usePlural?: boolean;

  /**
   * Enables Better Auth adapter debug logging.
   */
  debugLogs?: DBAdapterDebugLogOption;

  /**
   * Controls how SurrealDB generates record ids when Better Auth does not provide one.
   *
   * You can set a single default format:
   * - `"native"` (default)
   * - `"ulid"`
   * - `"uuidv7"`
   *
   * Or you can provide a function to control per-table behavior.
   */
  recordIdFormat?: RecordIdFormat | ((tableName: string) => RecordIdFormat);

  /**
   * Controls Better Auth transaction behavior for this adapter.
   *
   * - `"auto"` (default): use SurrealDB SDK session transactions when supported by
   *   the connected engine; otherwise fallback to Better Auth's non-transaction path.
   * - `true`: require session transactions. If unsupported, transaction calls throw.
   * - `false`: always disable database-backed transactions.
   */
  transaction?: "auto" | boolean;
}

type InternalSurrealAdapterConfig = SurrealAdapterConfig & {
  apiEndpoints?: boolean | SurrealApiEndpointsConfig;
};

type AdapterFactoryHelpers = Parameters<AdapterFactoryCustomizeAdapterCreator>[0];

/**
 * A query target can be:
 * - an entire table
 * - a single record id
 * - multiple explicit record ids
 */
type QueryTarget = Table | RecordId | RecordId[];

type ModelFieldContext = {
  dbFieldName: string;
  fieldAttributes: ReturnType<AdapterFactoryHelpers["getFieldAttributes"]>;
};

/**
 * Expected SurrealDB row result shape for standard record-returning queries.
 */
type QueryResultRows<T> = [T[]];

/**
 * Matches the id component of a SurrealDB record string such as:
 * - `user:abc123`
 * - `user:⟨abc123⟩`
 */
const RECORD_ID_SUFFIX_RE = /:(?:⟨([^⟩]+)⟩|([^⟩:]+))$/;

/**
 * Matches SurrealDB's UUID literal display form in some contexts:
 * - `u'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'`
 */
const UUID_LITERAL_RE = /^u(['"])(.+)\1$/;

/**
 * Creates a Better Auth database adapter backed by SurrealDB.
 *
 * Design notes:
 * - Better Auth's logical `id` is treated as the SurrealDB record key component.
 * - The record address is the SurrealDB record id (`table:id`), not a stored `id` column.
 * - Reference fields are mapped to SurrealDB `record<...>` links where applicable.
 *
 * @param db Connected SurrealDB client instance.
 * @param config Optional adapter configuration.
 * @returns A Better Auth adapter factory configured for SurrealDB.
 */
export const surrealAdapter = (db: Surreal, config?: SurrealAdapterConfig) => {
  const internalConfig = config as InternalSurrealAdapterConfig | undefined;
  const transactionMode = config?.transaction ?? "auto";

  const isUnsupportedSessionsFeatureError = (error: unknown): boolean => {
    if (error instanceof UnsupportedFeatureError) {
      return true;
    }
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes("does not support the feature") && message.includes("sessions");
    }
    return false;
  };

  const hasForkSessionMethod = "forkSession" in db && typeof db.forkSession === "function";

  const detectTransactionFeatureSupport = (): boolean | null => {
    if (typeof db.isFeatureSupported !== "function") {
      return null;
    }

    try {
      const supportsSessions = db.isFeatureSupported(Features.Sessions);
      const supportsTransactions = db.isFeatureSupported(Features.Transactions);
      return supportsSessions && supportsTransactions;
    } catch {
      return null;
    }
  };

  const initialTransactionSupport = detectTransactionFeatureSupport();
  let runtimeTransactionDisabled = transactionMode !== true && initialTransactionSupport === false;

  const adapterError = (message: string, cause?: unknown) => {
    const error = new Error(`[surrealdb-adapter] ${message}`);
    if (cause !== undefined) {
      (error as Error & { cause?: unknown }).cause = cause;
    }
    return error;
  };

  const executeQuery = async <T extends unknown[]>(
    client: Pick<SurrealQueryable, "query">,
    query: string | BoundQuery<T>,
  ): Promise<T> => {
    if (typeof query === "string") {
      return (await client.query<T>(query)) as T;
    }
    return (await client.query<T>(query)) as T;
  };

  /**
   * Resolves the record-id generation strategy for a given table.
   *
   * @param tableName SurrealDB table name.
   * @returns Record id format to use when SurrealDB should generate an id.
   */
  const resolveIdFormat = (tableName: string): RecordIdFormat => {
    const fmt = config?.recordIdFormat;
    const resolved = typeof fmt === "function" ? fmt(tableName) : (fmt ?? "native");
    if (resolved === "native" || resolved === "ulid" || resolved === "uuidv7") {
      return resolved;
    }
    throw adapterError(
      `Unsupported recordIdFormat "${String(resolved)}" for table "${tableName}". ` +
        'Use "native", "ulid", or "uuidv7".',
    );
  };

  /**
   * Normalizes uuid literals such as `u'...'` into the bare uuid string.
   *
   * @param value UUID string or Surreal uuid literal.
   * @returns Bare uuid string.
   */
  const normalizeUuidLiteral = (value: string): string => {
    const m = value.match(UUID_LITERAL_RE);
    return m ? m[2]! : value;
  };

  /**
   * Extracts the logical id component from values that might be:
   * - plain id ("abc123")
   * - record string ("user:abc123" / "user:⟨abc123⟩")
   *
   * Also normalizes Surreal UUID literal forms (u'...') into bare uuids.
   *
   * @param value An incoming id-like value.
   * @returns The extracted id component.
   */
  const toIdComponent = (value: unknown): string => {
    if (typeof value === "string") {
      const match = value.match(RECORD_ID_SUFFIX_RE);
      const idPart = match ? (match[1] ?? match[2] ?? value) : value;
      return normalizeUuidLiteral(idPart);
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
    throw new TypeError(`Invalid id value: ${Object.prototype.toString.call(value)}`);
  };

  /**
   * Converts a Better Auth id component into the correct RecordId id-part type
   * for the given table. For uuid tables, this returns a Uuid value type.
   *
   * @param tableName SurrealDB table name.
   * @param idComponent Better Auth id component string.
   * @returns A RecordId-compatible id part (string | Uuid).
   */
  const toRecordIdPart = (tableName: string, idComponent: string): string | Uuid => {
    const fmt = resolveIdFormat(tableName);
    if (fmt === "uuidv7") return u`${idComponent}`;
    return idComponent;
  };

  /**
   * Creates a SurrealDB RecordId from a table name and a Better Auth id-ish value.
   *
   * @param tableName SurrealDB table name.
   * @param value Better Auth logical id value (or Surreal-ish string).
   * @returns A SurrealDB RecordId.
   */
  const toRecordId = (tableName: string, value: unknown): RecordId => {
    const idComponent = toIdComponent(value);
    return new RecordId(tableName, toRecordIdPart(tableName, idComponent));
  };

  const extractRecordTable = (value: unknown): string | null => {
    if (value instanceof RecordId || value instanceof StringRecordId || typeof value === "string") {
      const raw = String(value);
      const separatorIndex = raw.indexOf(":");
      if (separatorIndex > 0) {
        return raw.slice(0, separatorIndex);
      }
    }
    return null;
  };

  const normalizeReferenceInput = (
    refTable: string,
    value: unknown,
    context: { model: string; field: string; operator?: string },
  ): unknown => {
    if (value === null || value === undefined) {
      return value;
    }

    if (value instanceof RecordId) {
      const table = extractRecordTable(value);
      if (table && table !== refTable) {
        throw adapterError(
          `Reference field "${context.field}" on model "${context.model}" expects a "${refTable}" record id, ` +
            `received "${table}".`,
        );
      }
      return value;
    }

    if (value instanceof StringRecordId) {
      const table = extractRecordTable(value);
      if (table && table !== refTable) {
        throw adapterError(
          `Reference field "${context.field}" on model "${context.model}" expects a "${refTable}" record id, ` +
            `received "${table}".`,
        );
      }
      return new RecordId(refTable, toRecordIdPart(refTable, toIdComponent(String(value))));
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      const table = extractRecordTable(value);
      if (table && table !== refTable) {
        throw adapterError(
          `Reference field "${context.field}" on model "${context.model}" expects a "${refTable}" record id, ` +
            `received "${table}".`,
        );
      }
      return new RecordId(refTable, toRecordIdPart(refTable, toIdComponent(value)));
    }

    throw adapterError(
      `Reference field "${context.field}" on model "${context.model}" requires a record id-compatible value` +
        `${context.operator ? ` for operator "${context.operator}"` : ""}.`,
    );
  };

  /**
   * Normalizes a SurrealDB record value into its raw id component.
   *
   * Examples:
   * - `user:abc123` -> `abc123`
   * - `user:⟨abc123⟩` -> `abc123`
   * - `RecordId("user", "abc123")` -> `abc123`
   * - `RecordId("user", Uuid(...))` -> `<uuid string>`
   *
   * @param value Raw value returned by SurrealDB.
   * @returns The extracted logical id, or the original value if it is not a record id.
   */
  const stripRecordPrefix = (value: unknown): unknown => {
    if (value instanceof RecordId) {
      const v = value.id;
      return v instanceof Uuid ? v.toString() : String(v);
    }

    if (value instanceof StringRecordId) {
      const raw = String(value);
      const match = raw.match(RECORD_ID_SUFFIX_RE);
      const idPart = match ? (match[1] ?? match[2] ?? raw) : raw;
      return normalizeUuidLiteral(idPart);
    }

    if (typeof value === "string") {
      const match = value.match(RECORD_ID_SUFFIX_RE);
      const idPart = match ? (match[1] ?? match[2] ?? value) : value;
      return normalizeUuidLiteral(idPart);
    }

    return value;
  };

  const createCustomAdapter =
    (client: Pick<SurrealQueryable, "query">): AdapterFactoryCustomizeAdapterCreator =>
    ({ getModelName, getFieldName, getFieldAttributes }: AdapterFactoryHelpers) => {
      const modelNameCache = new Map<string, string>();
      const fieldContextCache = new Map<string, ModelFieldContext>();

      const resolveModelName = (model: string) => {
        const cached = modelNameCache.get(model);
        if (cached) return cached;

        const tableName = getModelName(model);
        modelNameCache.set(model, tableName);
        return tableName;
      };

      const resolveFieldContext = (model: string, field: string): ModelFieldContext => {
        const key = `${model}:${field}`;
        const cached = fieldContextCache.get(key);
        if (cached) return cached;

        try {
          const resolved = {
            dbFieldName: getFieldName({ field, model }),
            fieldAttributes: getFieldAttributes({ field, model }),
          };
          fieldContextCache.set(key, resolved);
          return resolved;
        } catch (error) {
          throw adapterError(
            `Field "${field}" is not defined for model "${model}". ` +
              "Check your Better Auth schema and adapter usage.",
            error,
          );
        }
      };

      const assertWritePayload = (model: string, input: Record<string, unknown>) => {
        for (const key of Object.keys(input)) {
          if (key === "id") continue;
          resolveFieldContext(model, key);
        }
      };

      /**
       * Normalizes a Better Auth connector into a supported SQL boolean operator.
       */
      const safeConnector = (connector?: string): "AND" | "OR" =>
        connector?.toUpperCase() === "OR" ? "OR" : "AND";

      /**
       * Removes the logical `id` property from a write payload so it is not
       * persisted as a normal column. In this adapter, `id` is represented by
       * the SurrealDB record address.
       */
      const stripIdFromPayload = <T extends Record<string, unknown>>(input: T): Omit<T, "id"> => {
        const { id: _id, ...rest } = input;
        return rest;
      };

      /**
       * SurrealDB expects `NONE` for option-field clears.
       * The client serializer emits `NONE` for `undefined`, so we normalize
       * incoming `null` values to `undefined` before writes.
       */
      const normalizeNullToNone = (value: unknown): unknown => {
        if (value === null) return undefined;
        if (
          value instanceof RecordId ||
          value instanceof StringRecordId ||
          value instanceof Uuid ||
          value instanceof Date ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        if (Array.isArray(value)) return value.map((entry) => normalizeNullToNone(entry));
        if (value && typeof value === "object") {
          const proto = Object.getPrototypeOf(value);
          if (proto === null || proto === Object.prototype || proto.constructor.name === "Object") {
            const normalized: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
              normalized[k] = normalizeNullToNone(v);
            }
            return normalized;
          }
        }
        return value;
      };

      const isTableTarget = (target: QueryTarget): target is Table => target instanceof Table;

      const splitIdWhere = (
        model: string,
        where?: Where[],
      ): { target: QueryTarget; rest: Where[] } => {
        const tableTarget = new Table(model);

        if (!where?.length) {
          return { target: tableTarget, rest: [] };
        }

        const hasOr = where.some((w, i) => i > 0 && safeConnector(w.connector) === "OR");
        if (hasOr) {
          return { target: tableTarget, rest: where };
        }

        const ids: RecordId[] = [];
        const rest: Where[] = [];

        for (const w of where) {
          const operator = (w.operator ?? "eq").toLowerCase();

          if (w.field === "id" && operator === "eq") {
            ids.push(toRecordId(model, w.value));
            continue;
          }

          if (w.field === "id" && operator === "in") {
            if (Array.isArray(w.value) && w.value.length > 0) {
              ids.push(...w.value.map((value) => toRecordId(model, value)));
              continue;
            }

            rest.push(w);
            continue;
          }

          rest.push(w);
        }

        if (ids.length === 0) {
          return { target: tableTarget, rest };
        }

        if (ids.length === 1) {
          return { target: ids[0]!, rest };
        }

        return { target: ids, rest };
      };

      const customExpr = (sqlFactory: (ctx: { def: (value: unknown) => string }) => string): Expr =>
        ({ toSQL: sqlFactory }) as Expr;

      const wrapQueryError = (error: unknown, context: string): never => {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof ConnectionUnavailableError) {
          throw adapterError(
            `SurrealDB connection is unavailable while ${context}. Ensure the client is connected.`,
            error,
          );
        }

        if (error instanceof MissingNamespaceDatabaseError) {
          throw adapterError(
            `SurrealDB namespace/database is not selected while ${context}. Call db.use(...) first.`,
            error,
          );
        }

        if (error instanceof InvalidSessionError) {
          throw adapterError(
            `SurrealDB session is invalid while ${context}. The active transaction/session may have been closed.`,
            error,
          );
        }

        if (error instanceof ServerError) {
          const fieldCoercionMatch = error.message.match(
            /Couldn't coerce value for field `([^`]+)`/i,
          );
          if (fieldCoercionMatch) {
            throw adapterError(
              `Invalid value for field "${fieldCoercionMatch[1]}" while ${context}.`,
              error,
            );
          }

          if (
            error.kind === "AlreadyExists" ||
            /unique/i.test(error.message) ||
            /duplicate/i.test(error.message)
          ) {
            throw adapterError(`Unique constraint violation while ${context}.`, error);
          }
        }

        if (error instanceof SurrealError) {
          throw adapterError(`SurrealDB error while ${context}: ${error.message}`, error);
        }

        const fieldCoercionMatch = message.match(/Couldn't coerce value for field `([^`]+)`/i);

        if (fieldCoercionMatch) {
          throw adapterError(
            `Invalid value for field "${fieldCoercionMatch[1]}" while ${context}.`,
            error,
          );
        }

        if (/unique/i.test(message) || /duplicate/i.test(message)) {
          throw adapterError(`Unique constraint violation while ${context}.`, error);
        }

        throw adapterError(`SurrealDB query failed while ${context}: ${message}`, error);
      };

      const isSupportedOperator = (operator: string) =>
        [
          "eq",
          "ne",
          "lt",
          "lte",
          "gt",
          "gte",
          "contains",
          "in",
          "starts_with",
          "ends_with",
        ].includes(operator);

      const buildCondition = (model: string, where: Where): ExprLike => {
        const { dbFieldName: fieldName, fieldAttributes } = resolveFieldContext(model, where.field);
        const operator = (where.operator ?? "eq").toLowerCase();
        let value: unknown = where.value;

        if (!isSupportedOperator(operator)) {
          throw adapterError(
            `Unsupported operator "${operator}" for field "${where.field}" on model "${model}".`,
          );
        }

        if (operator === "in" && !Array.isArray(value)) {
          throw adapterError(
            `Operator "in" requires an array value for field "${where.field}" on model "${model}".`,
          );
        }

        if (fieldAttributes?.references && operator !== "in") {
          const refTable = fieldAttributes.references.model;
          value = normalizeReferenceInput(refTable, value, {
            model,
            field: where.field,
            operator,
          });
        } else if (fieldAttributes?.references && operator === "in" && Array.isArray(value)) {
          const refTable = fieldAttributes.references.model;
          value = value.map((entry) =>
            normalizeReferenceInput(refTable, entry, {
              model,
              field: where.field,
              operator,
            }),
          );
        }

        const ident = escapeIdent(fieldName);

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
        }

        throw adapterError(
          `Unsupported operator "${operator}" for field "${where.field}" on model "${model}".`,
        );
      };

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

      const appendWhere = (query: BoundQuery, model: string, where?: Where[]) => {
        const clause = buildWhereExpr(model, where);
        if (clause) {
          query.append(" WHERE ");
          query.append(expr(clause));
        }
      };

      const makeTargetQuery = (
        sqlForTable: (tableName: string) => string,
        sqlForTarget: string,
        model: string,
        target: QueryTarget,
      ): BoundQuery => {
        if (isTableTarget(target)) {
          return new BoundQuery(sqlForTable(model));
        }
        return new BoundQuery(sqlForTarget, { target });
      };

      const queryMany = async <T>(query: BoundQuery, context = "reading records"): Promise<T[]> => {
        try {
          const [rows] = await executeQuery<QueryResultRows<T>>(client, query);
          return rows ?? [];
        } catch (error) {
          return wrapQueryError(error, context);
        }
      };

      const queryOne = async <T>(
        query: BoundQuery,
        context = "reading a record",
      ): Promise<T | null> => {
        try {
          const [rows] = await executeQuery<QueryResultRows<T>>(client, query);
          return rows?.[0] ?? null;
        } catch (error) {
          return wrapQueryError(error, context);
        }
      };

      const queryScalar = async <T>(
        query: BoundQuery,
        context = "reading a scalar value",
      ): Promise<T | null> => {
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
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT count() AS count FROM ${escapeIdent(tb)}`,
            "SELECT count() AS count FROM $target",
            tableName,
            target,
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

          let query: BoundQuery;

          if (rawId != null) {
            const rid = toRecordId(tableName, rawId);
            query = new BoundQuery(`CREATE $rid CONTENT $data`, { rid, data: content });
          } else {
            const fmt = resolveIdFormat(tableName);

            if (fmt === "ulid") {
              query = new BoundQuery(`CREATE ${escapeIdent(tableName)}:ulid() CONTENT $data`, {
                data: content,
              });
            } else if (fmt === "uuidv7") {
              query = new BoundQuery(`CREATE ${escapeIdent(tableName)}:uuid() CONTENT $data`, {
                data: content,
              });
            } else {
              query = new BoundQuery(`CREATE ${escapeIdent(tableName)} CONTENT $data`, {
                data: content,
              });
            }
          }

          const created = await queryOne<T>(query, `creating a record in "${tableName}"`);
          if (!created) {
            throw adapterError(`Failed to create record in "${tableName}".`);
          }
          return created;
        },

        findOne: async <T>({
          model,
          where,
        }: {
          model: string;
          where: Where[];
        }): Promise<T | null> => {
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
            tableName,
            target,
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
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);

          if (sortBy) {
            const sortField = escapeIdent(resolveFieldContext(model, sortBy.field).dbFieldName);
            const sortDirection = sortBy.direction === "desc" ? "DESC" : "ASC";
            query.append(` ORDER BY ${sortField} ${sortDirection}`);
          }

          if (typeof limit === "number") {
            query.append(surql` LIMIT ${limit}`);
          }

          if (typeof offset === "number") {
            query.append(surql` START ${offset}`);
          }

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
          const tableName = resolveModelName(model);
          const { target, rest = [] } = splitIdWhere(tableName, where);
          const payload = update as Record<string, unknown>;
          assertWritePayload(model, payload);
          const patch = normalizeNullToNone(stripIdFromPayload(payload));

          const query = makeTargetQuery(
            (tb) => `UPDATE ${escapeIdent(tb)}`,
            "UPDATE $target",
            tableName,
            target,
          );

          query.append(surql` MERGE ${patch}`);
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
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);
          assertWritePayload(model, update);
          const patch = normalizeNullToNone(stripIdFromPayload(update));

          const query = makeTargetQuery(
            (tb) => `RETURN array::len((UPDATE ${escapeIdent(tb)}`,
            "RETURN array::len((UPDATE $target",
            tableName,
            target,
          );

          query.append(surql` MERGE ${patch}`);
          appendWhere(query, tableName, rest);
          query.append(" RETURN VALUE id))");

          return (await queryScalar<number>(query, `updating records in "${tableName}"`)) ?? 0;
        },

        delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `DELETE ${escapeIdent(tb)}`,
            "DELETE $target",
            tableName,
            target,
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
          const tableName = resolveModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `RETURN array::len((DELETE ${escapeIdent(tb)}`,
            "RETURN array::len((DELETE $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);
          query.append(" RETURN VALUE id))");

          return (await queryScalar<number>(query, `deleting records from "${tableName}"`)) ?? 0;
        },

        createSchema: async ({ file, tables }: { file?: string; tables: BetterAuthDBSchema }) => {
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

  const adapterFactoryOptions: AdapterFactoryOptions = {
    config: {
      adapterId: "surrealdb-adapter",
      adapterName: "SurrealDB Adapter",
      usePlural: config?.usePlural ?? false,
      debugLogs: config?.debugLogs ?? false,
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      supportsNumericIds: false,

      /**
       * Better Auth should not generate ids itself.
       * SurrealDB record ids act as the record-address.
       *
       * NOTE: If Better Auth provides an `id`, we still honor it as the record key component.
       */
      disableIdGeneration: true,

      /**
       * Transforms incoming Better Auth values before they are written to SurrealDB.
       *
       * Reference fields are converted from Better Auth string ids into SurrealDB
       * `RecordId` instances so they can be stored as `record<...>` links.
       */
      customTransformInput: ({
        field,
        model,
        fieldAttributes,
        data,
      }: {
        field: string;
        model: string;
        fieldAttributes: { references?: { model: string } } | undefined;
        data: unknown;
      }) => {
        if (fieldAttributes?.references) {
          const refTable = fieldAttributes.references.model;
          return normalizeReferenceInput(refTable, data, { model, field });
        }
        return data;
      },

      /**
       * Transforms outgoing SurrealDB values into Better Auth friendly values.
       *
       * Primary ids and reference fields are normalized from SurrealDB record ids
       * back into plain Better Auth id strings.
       */
      customTransformOutput: ({
        field,
        data,
        fieldAttributes,
      }: {
        field: string;
        data: unknown;
        fieldAttributes: { references?: { model: string } } | undefined;
      }) => {
        if (field === "id" || fieldAttributes?.references) {
          return stripRecordPrefix(data);
        }
        if (data instanceof DateTime) {
          return data.toDate();
        }
        return data;
      },
      transaction:
        transactionMode === false ||
        (transactionMode === "auto" &&
          (!hasForkSessionMethod || initialTransactionSupport === false))
          ? false
          : async <R>(callback: (trx: DBTransactionAdapter) => Promise<R>) => {
              const runWithoutDatabaseTransaction = async () => {
                const noTxAdapter = createAdapterFactory({
                  config: { ...adapterFactoryOptions.config, transaction: false },
                  adapter: createCustomAdapter(db),
                })(lazyOptions!);

                return callback(noTxAdapter);
              };

              if (!hasForkSessionMethod) {
                if (transactionMode === true) {
                  throw adapterError(
                    "Transactions were explicitly enabled, but this SurrealDB client does not expose forkSession().",
                  );
                }
                return runWithoutDatabaseTransaction();
              }

              if (runtimeTransactionDisabled && transactionMode !== true) {
                return runWithoutDatabaseTransaction();
              }

              let session: SurrealSession | null = null;

              try {
                session = await db.forkSession();
              } catch (error) {
                if (isUnsupportedSessionsFeatureError(error) && transactionMode !== true) {
                  runtimeTransactionDisabled = true;
                  return runWithoutDatabaseTransaction();
                }
                throw adapterError("Failed to initialize a SurrealDB transaction session.", error);
              }

              try {
                const transaction = await session.beginTransaction();
                const adapter = createAdapterFactory({
                  config: adapterFactoryOptions.config,
                  adapter: createCustomAdapter(transaction),
                })(lazyOptions!);

                try {
                  const result = await callback(adapter);
                  await transaction.commit();
                  return result;
                } catch (error) {
                  try {
                    await transaction.cancel();
                  } catch {
                    // Preserve the original error when rollback also fails.
                  }
                  throw error;
                }
              } catch (error) {
                if (isUnsupportedSessionsFeatureError(error) && transactionMode !== true) {
                  runtimeTransactionDisabled = true;
                  return runWithoutDatabaseTransaction();
                }
                throw error;
              } finally {
                await session.closeSession();
              }
            },
    },
    adapter: createCustomAdapter(db),
  };

  const baseFactory = createAdapterFactory(adapterFactoryOptions);

  return (options: BetterAuthOptions) => {
    lazyOptions = options;
    return baseFactory(options);
  };
};

/**
 * Arguments for the SurQL schema generator.
 */
export interface GenerateSurqlSchemaOptions {
  file?: string;
  tables?: BetterAuthDBSchema;
  getModelName: AdapterFactoryHelpers["getModelName"];
  getFieldName: AdapterFactoryHelpers["getFieldName"];
  /**
   * Internal/test-only option for optional SurrealDB DEFINE API generation.
   */
  apiEndpoints?: boolean | SurrealApiEndpointsConfig;
}

export interface ApplySurqlSchemaOptions {
  db: Surreal;
  authOptions: BetterAuthOptions;
  file?: string;
}

const splitSurqlStatements = (code: string): string[] =>
  code
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);

export const executeSurqlSchema = async (db: Surreal, code: string) => {
  for (const statement of splitSurqlStatements(code)) {
    try {
      await db.query(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) {
        throw error;
      }
    }
  }
};

/**
 * Returns a SurQL schema string based on the provided Better Auth schema.
 *
 * This function is decoupled from the adapter factory to allow direct testing.
 */
export const generateSurqlSchema = async (options: GenerateSurqlSchemaOptions) => {
  const { file, tables, getModelName, getFieldName, apiEndpoints } = options;
  const code: string[] = [];
  const apiTableNames: string[] = [];
  const resolvedApiConfig =
    apiEndpoints === true
      ? {}
      : apiEndpoints && typeof apiEndpoints === "object"
        ? apiEndpoints
        : null;
  const apiBasePath = (() => {
    const raw = resolvedApiConfig?.basePath?.trim() || "";
    const trimmed = raw.replace(/^\/+|\/+$/g, "");
    return trimmed ? `/${trimmed}` : "";
  })();
  const apiModels = new Set(
    resolvedApiConfig?.models?.length
      ? resolvedApiConfig.models
      : ["user", "session", "account", "jwks"],
  );

  for (const tableKey in tables) {
    const table = tables[tableKey];
    if (!table) continue;

    const tableName = escapeIdent(getModelName(table.modelName));
    const rawTableName = getModelName(table.modelName);
    code.push(`DEFINE TABLE ${tableName} SCHEMAFULL;`);

    if (resolvedApiConfig && apiModels.has(table.modelName)) {
      apiTableNames.push(rawTableName);
    }

    for (const fieldKey in table.fields) {
      const field = table.fields[fieldKey];
      if (!field) continue;

      const dbFieldName = field.fieldName || fieldKey;
      if (dbFieldName === "id") continue;

      const fieldName = escapeIdent(getFieldName({ field: dbFieldName, model: table.modelName }));

      if (Array.isArray(field.type)) {
        throw new Error(`Array type not supported: ${JSON.stringify(field.type)}`);
      }

      const primitiveType = (
        {
          string: "string",
          number: "number",
          boolean: "bool",
          date: "datetime",
          "number[]": "array<number>",
          "string[]": "array<string>",
        } as Record<string, string>
      )[field.type as string];

      let type = primitiveType;

      if (field.references) {
        type = `record<${escapeIdent(getModelName(field.references.model))}>`;
      } else if (!type) {
        throw new Error(
          `Unsupported field type "${String(field.type)}" for ${table.modelName}.${dbFieldName}`,
        );
      }

      if (!field.required) {
        type = `option<${type}>`;
      }

      code.push(`DEFINE FIELD ${fieldName} ON ${tableName} TYPE ${type};`);

      if (field.unique) {
        const base = tableName.replace(/`/g, "");
        const col = fieldName.replace(/`/g, "");
        const idxName = `${base}${col.charAt(0).toUpperCase()}${col.slice(1)}_idx`;
        code.push(
          `DEFINE INDEX ${escapeIdent(idxName)} ON ${tableName} COLUMNS ${fieldName} UNIQUE;`,
        );
      } else if (field.references || fieldKey.toLowerCase().includes("id")) {
        code.push(
          `DEFINE INDEX ${escapeIdent(`${fieldName.replace(/`/g, "")}_idx`)} ON ${tableName} COLUMNS ${fieldName};`,
        );
      }
    }

    code.push("");
  }

  if (resolvedApiConfig) {
    for (const tableName of apiTableNames) {
      const path = `${apiBasePath}/${tableName}`;
      const escapedTable = escapeIdent(tableName);
      code.push(`DEFINE API OVERWRITE "${path}"`);
      code.push("  FOR get");
      code.push("  MIDDLEWARE");
      code.push('    api::res::body("json")');
      code.push("  THEN {");
      code.push("    {");
      code.push("      status: 200,");
      code.push(`      body: SELECT * FROM ${escapedTable}`);
      code.push("    }");
      code.push("  }");
      code.push(";");
      code.push("");
    }
  }

  const suggested = file ? file.replace(/\.[^/.]+$/, ".surql") : ".better-auth/schema.surql";

  return { code: code.join("\n"), path: suggested };
};

/**
 * Generates SurQL from a Better Auth configuration and applies it to the active
 * SurrealDB connection.
 */
export const applySurqlSchema = async ({ db, authOptions, file }: ApplySurqlSchemaOptions) => {
  const adapterFactory = authOptions.database as unknown as (input: {
    plugins?: BetterAuthOptions["plugins"];
  }) => {
    createSchema?: (
      options: BetterAuthOptions,
      file?: string,
    ) => Promise<{ code: string; path: string }>;
  };

  const adapter = adapterFactory({
    plugins: authOptions.plugins,
  });

  if (!adapter.createSchema) {
    throw new Error("The configured Better Auth adapter does not implement createSchema().");
  }

  const result = await adapter.createSchema(authOptions, file);
  if (result.code.trim()) {
    await executeSurqlSchema(db, result.code);
  }

  return result;
};
