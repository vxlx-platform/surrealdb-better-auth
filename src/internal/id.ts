import { RecordId, StringRecordId, Uuid, u } from "surrealdb";

type AdapterErrorFactory = (message: string, cause?: unknown) => Error;
type RecordIdFormatResolver = (tableName: string) => "native" | "ulid" | "uuidv7";
type ParsedRecordIdLike = { table: string | null; idComponent: string };
const RECORD_ID_SUFFIX_RE = /:(?:⟨([^⟩]+)⟩|([^⟩:]+))$/;
const UUID_LITERAL_RE = /^u(['"])(.+)\1$/;
export type ReferenceContext = { model: string; field: string; operator?: string };

/** Normalizes Surreal UUID literal syntax `u'...'` / `u"..."` into plain uuid strings. */
const normalizeUuidLiteral = (value: string): string => {
  const m = value.match(UUID_LITERAL_RE);
  return m ? m[2]! : value;
};

/** Parses string record-id variants into `{ table, idComponent }`. */
const parseRecordIdString = (raw: string): ParsedRecordIdLike => {
  const i = raw.indexOf(":");
  const m = raw.match(RECORD_ID_SUFFIX_RE);
  return {
    table: i > 0 ? raw.slice(0, i) : null,
    idComponent: normalizeUuidLiteral(m?.[1] ?? m?.[2] ?? raw),
  };
};

/** Parses RecordId/StringRecordId/string/number/bigint values into a unified id shape. */
const parseRecordIdLike = (val: unknown): ParsedRecordIdLike | null => {
  if (val instanceof RecordId)
    return {
      table: val.table.name,
      idComponent: val.id instanceof Uuid ? val.id.toString() : String(val.id),
    };
  if (val instanceof StringRecordId || typeof val === "string")
    return parseRecordIdString(String(val));
  if (typeof val === "number" || typeof val === "bigint")
    return { table: null, idComponent: String(val) };
  return null;
};

/** Extracts the id component or throws for unsupported input types. */
const toIdComponent = (value: unknown): string => {
  const parsed = parseRecordIdLike(value);
  if (parsed) return parsed.idComponent;
  throw new TypeError(`Invalid id value: ${Object.prototype.toString.call(value)}`);
};

export const createIdHelpers = ({
  resolveIdFormat,
  adapterError,
}: {
  resolveIdFormat: RecordIdFormatResolver;
  adapterError: AdapterErrorFactory;
}) => {
  /** Converts ids to a proper Surreal record-id part based on configured table format. */
  const toRecordIdPart = (tableName: string, id: string): string | Uuid =>
    resolveIdFormat(tableName) === "uuidv7" ? u`${id}` : id;

  const toRecordId = (tableName: string, value: unknown): RecordId =>
    new RecordId(tableName, toRecordIdPart(tableName, toIdComponent(value)));

  /** Normalizes Better Auth reference-field inputs into Surreal `RecordId` values. */
  const normalizeReferenceInput = (ref: string, val: unknown, ctx: ReferenceContext): unknown => {
    if (val == null) return val;
    const assertTable = (inc: string | null) => {
      if (inc && inc !== ref) {
        throw adapterError(
          `Reference field "${ctx.field}" on model "${ctx.model}" expects a "${ref}" record id, received "${inc}".`,
        );
      }
    };
    if (val instanceof RecordId) return (assertTable(val.table.name), val);
    const p = parseRecordIdLike(val);
    if (p) return (assertTable(p.table), new RecordId(ref, toRecordIdPart(ref, p.idComponent)));

    throw adapterError(
      `Reference field "${ctx.field}" on model "${ctx.model}" requires a record id-compatible value` +
        `${ctx.operator ? ` for operator "${ctx.operator}"` : ""}.`,
    );
  };

  /** Converts record-id-like values back to Better Auth logical ids. */
  const stripRecordPrefix = (value: unknown): unknown =>
    value instanceof RecordId || value instanceof StringRecordId || typeof value === "string"
      ? (parseRecordIdLike(value)?.idComponent ?? value)
      : value;
  return { toRecordId, normalizeReferenceInput, stripRecordPrefix };
};
