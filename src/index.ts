import {
  createAdapterFactory,
  type DBAdapterDebugLogOption,
  type Where,
} from "better-auth/adapters";
import { type BetterAuthDBSchema } from "better-auth";
import {
  BoundQuery,
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
  u,
  type Expr,
  type ExprLike,
  type Surreal,
} from "surrealdb";

/**
 * Supported SurrealDB record-id generation formats when Better Auth does not supply an id.
 *
 * - `random`: SurrealDB default random IDs (CREATE table CONTENT ...).
 * - `ulid`: SurrealDB ULID IDs (CREATE table:ulid() CONTENT ...).
 * - `uuidv7`: SurrealDB UUIDv7 IDs (CREATE table:uuid() CONTENT ...).
 */
export type RecordIdFormat = "random" | "ulid" | "uuidv7";

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
   * - `"random"` (default)
   * - `"ulid"`
   * - `"uuidv7"`
   *
   * Or you can provide a function to control per-table behavior.
   */
  recordIdFormat?: RecordIdFormat | ((tableName: string) => RecordIdFormat);
}

/**
 * A query target can be:
 * - an entire table
 * - a single record id
 * - multiple explicit record ids
 */
type QueryTarget = Table | RecordId | RecordId[];

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
  /**
   * Resolves the record-id generation strategy for a given table.
   *
   * @param tableName SurrealDB table name.
   * @returns Record id format to use when SurrealDB should generate an id.
   */
  const resolveIdFormat = (tableName: string): RecordIdFormat => {
    const fmt = config?.recordIdFormat;
    if (typeof fmt === "function") return fmt(tableName);
    return fmt ?? "random";
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

  return createAdapterFactory({
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
      customTransformInput: ({ fieldAttributes, data }) => {
        if (fieldAttributes?.references && typeof data === "string") {
          const refTable = fieldAttributes.references.model;
          return new RecordId(refTable, toRecordIdPart(refTable, toIdComponent(data)));
        }
        return data;
      },

      /**
       * Transforms outgoing SurrealDB values into Better Auth friendly values.
       *
       * Primary ids and reference fields are normalized from SurrealDB record ids
       * back into plain Better Auth id strings.
       */
      customTransformOutput: ({ field, data, fieldAttributes }) => {
        if (field === "id" || fieldAttributes?.references) {
          return stripRecordPrefix(data);
        }
        return data;
      },
    },

    adapter: ({ getModelName, getFieldName, getFieldAttributes }) => {
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
       * SurrealDB expects `NONE` for option-field clears (not SQL NULL).
       * The client serializer emits `NONE` for `undefined`, so we normalize
       * incoming `null` values to `undefined` before writes.
       */
      const normalizeNullToNone = (value: unknown): unknown => {
        if (value === null) return undefined;
        if (Array.isArray(value)) return value.map((entry) => normalizeNullToNone(entry));
        if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
          const normalized: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) {
            normalized[k] = normalizeNullToNone(v);
          }
          return normalized;
        }
        return value;
      };

      /**
       * Runtime type guard for distinguishing a table target from explicit record targets.
       */
      const isTableTarget = (target: QueryTarget): target is Table => target instanceof Table;

      /**
       * Splits `where` conditions into:
       * - a direct SurrealDB target (table, one record id, or many record ids)
       * - remaining conditions that must still be applied in a `WHERE` clause
       *
       * For mixed `OR` expressions, this conservatively falls back to scanning the table
       * and leaves all conditions in `rest` for correctness.
       */
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

            // Keep invalid/empty IN conditions in WHERE so they don't broaden scope.
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

      /**
       * Creates a lightweight custom SurrealDB expression object for operators
       * not covered by the built-in expression helpers.
       */
      const customExpr = (sqlFactory: (ctx: { def: (value: unknown) => string }) => string): Expr =>
        ({ toSQL: sqlFactory }) as Expr;

      /**
       * Converts a single Better Auth `Where` condition into a SurrealDB expression.
       *
       * Reference values are converted into `RecordId` objects when needed so that
       * comparisons work against `record<...>` fields.
       */
      const buildCondition = (model: string, where: Where): ExprLike => {
        const fieldName = getFieldName({ field: where.field, model });
        const fieldAttributes = getFieldAttributes({ field: where.field, model });

        const operator = where.operator ?? "eq";
        let value: unknown = where.value;

        if (fieldAttributes?.references && typeof value === "string") {
          const refTable = fieldAttributes.references.model;
          value = new RecordId(refTable, toRecordIdPart(refTable, toIdComponent(value)));
        } else if (fieldAttributes?.references && operator === "in" && Array.isArray(value)) {
          const refTable = fieldAttributes.references.model;
          value = value.map((entry) => {
            if (typeof entry === "string" || typeof entry === "number" || typeof entry === "bigint") {
              return new RecordId(refTable, toRecordIdPart(refTable, toIdComponent(entry)));
            }
            return entry;
          });
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
          default:
            return eq(ident, value);
        }
      };

      /**
       * Builds a full SurrealDB boolean expression from a Better Auth `Where[]` array.
       *
       * Conditions are combined left-to-right using Better Auth connector semantics.
       */
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

      /**
       * Appends a compiled `WHERE` clause to a query if conditions are present.
       */
      const appendWhere = (query: BoundQuery, model: string, where?: Where[]) => {
        const clause = buildWhereExpr(model, where);
        if (clause) {
          query.append(" WHERE ");
          query.append(expr(clause));
        }
      };

      /**
       * Creates a query targeting either:
       * - a full table
       * - one explicit record id
       * - many explicit record ids
       */
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

      /**
       * Executes a query expected to return many rows.
       */
      const queryMany = async <T>(query: BoundQuery): Promise<T[]> => {
        const [rows] = await db.query<QueryResultRows<T>>(query);
        return rows ?? [];
      };

      /**
       * Executes a query expected to return zero or one row.
       */
      const queryOne = async <T>(query: BoundQuery): Promise<T | null> => {
        const [rows] = await db.query<QueryResultRows<T>>(query);
        return rows?.[0] ?? null;
      };

      /**
       * Executes a query expected to return a single scalar value.
       */
      const queryScalar = async <T>(query: BoundQuery): Promise<T | null> => {
        const [value] = await db.query<[T]>(query);
        return value ?? null;
      };

      return {
        options: config,

        count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT count() AS count FROM ${escapeIdent(tb)}`,
            "SELECT count() AS count FROM $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);
          query.append(" GROUP ALL");

          const rows = await queryMany<{ count: number }>(query);
          return rows[0]?.count ?? 0;
        },

        create: async <T>({ model, data }: { model: string; data: T }): Promise<T> => {
          const tableName = getModelName(model);
          const payload = data as Record<string, unknown>;
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
              // "random" (default)
              query = new BoundQuery(`CREATE ${escapeIdent(tableName)} CONTENT $data`, {
                data: content,
              });
            }
          }

          const created = await queryOne<T>(query);
          if (!created) throw new Error(`Failed to create record in ${tableName}`);
          return created;
        },

        findOne: async <T>({
          model,
          where,
        }: {
          model: string;
          where: Where[];
        }): Promise<T | null> => {
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);
          query.append(" LIMIT 1");

          return queryOne<T>(query);
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
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `SELECT * FROM ${escapeIdent(tb)}`,
            "SELECT * FROM $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);

          if (sortBy) {
            const sortField = escapeIdent(getFieldName({ field: sortBy.field, model }));
            const sortDirection = sortBy.direction === "desc" ? "DESC" : "ASC";
            query.append(` ORDER BY ${sortField} ${sortDirection}`);
          }

          if (typeof limit === "number") {
            query.append(` LIMIT ${limit}`);
          }

          if (typeof offset === "number") {
            query.append(` START ${offset}`);
          }

          return queryMany<T>(query);
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
          const tableName = getModelName(model);
          const { target, rest = [] } = splitIdWhere(tableName, where);
          const patch = normalizeNullToNone(stripIdFromPayload(update as Record<string, unknown>));

          const query = makeTargetQuery(
            (tb) => `UPDATE ${escapeIdent(tb)}`,
            "UPDATE $target",
            tableName,
            target,
          );

          query.append(surql` MERGE ${patch}`);
          appendWhere(query, tableName, rest);
          query.append(" RETURN AFTER");

          return queryOne<T>(query);
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
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);
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

          return (await queryScalar<number>(query)) ?? 0;
        },

        delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `DELETE ${escapeIdent(tb)}`,
            "DELETE $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);
          await db.query(query);
        },

        deleteMany: async ({
          model,
          where,
        }: {
          model: string;
          where: Where[];
        }): Promise<number> => {
          const tableName = getModelName(model);
          const { target, rest } = splitIdWhere(tableName, where);

          const query = makeTargetQuery(
            (tb) => `RETURN array::len((DELETE ${escapeIdent(tb)}`,
            "RETURN array::len((DELETE $target",
            tableName,
            target,
          );

          appendWhere(query, tableName, rest);
          query.append(" RETURN VALUE id))");

          return (await queryScalar<number>(query)) ?? 0;
        },

        createSchema: async (options) => {
          return generateSurqlSchema({
            ...options,
            getModelName,
            getFieldName,
          });
        },
      };
    },
  });
};

/**
 * Arguments for the SurQL schema generator.
 */
export interface GenerateSurqlSchemaOptions {
  file?: string;
  tables?: BetterAuthDBSchema;
  getModelName: (modelName: string) => string;
  getFieldName: (options: { field: string; model: string }) => string;
}

/**
 * Returns a SurQL schema string based on the provided Better Auth schema.
 *
 * This function is decoupled from the adapter factory to allow direct testing.
 */
export const generateSurqlSchema = async (options: GenerateSurqlSchemaOptions) => {
  const { file, tables, getModelName, getFieldName } = options;
  const code: string[] = [];

  for (const tableKey in tables) {
    const table = tables[tableKey];
    if (!table) continue;

    const tableName = escapeIdent(getModelName(table.modelName));
    code.push(`DEFINE TABLE ${tableName} SCHEMAFULL;`);

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
        throw new Error(`Unsupported field type "${String(field.type)}" for ${table.modelName}.${dbFieldName}`);
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

  const suggested = file ? file.replace(/\.[^/.]+$/, ".surql") : ".better-auth/schema.surql";

  return { code: code.join("\n"), path: suggested };
};
