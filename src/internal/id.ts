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
  const separatorIndex = raw.indexOf(":");
  const table = separatorIndex > 0 ? raw.slice(0, separatorIndex) : null;
  const match = raw.match(RECORD_ID_SUFFIX_RE);
  const idPart = match ? (match[1] ?? match[2] ?? raw) : raw;
  return { table, idComponent: normalizeUuidLiteral(idPart) };
};

/** Parses RecordId/StringRecordId/string/number/bigint values into a unified id shape. */
const parseRecordIdLike = (value: unknown): ParsedRecordIdLike | null => {
  if (value instanceof RecordId) {
    const idPart = value.id;
    return {
      table: value.table.name,
      idComponent: idPart instanceof Uuid ? idPart.toString() : String(idPart),
    };
  }
  if (value instanceof StringRecordId) return parseRecordIdString(String(value));
  if (typeof value === "string") return parseRecordIdString(value);
  if (typeof value === "number" || typeof value === "bigint")
    return { table: null, idComponent: String(value) };
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
  const toRecordIdPart = (tableName: string, idComponent: string): string | Uuid => {
    return resolveIdFormat(tableName) === "uuidv7" ? u`${idComponent}` : idComponent;
  };
  const toRecordId = (tableName: string, value: unknown): RecordId =>
    new RecordId(tableName, toRecordIdPart(tableName, toIdComponent(value)));

  /** Normalizes Better Auth reference-field inputs into Surreal `RecordId` values. */
  const normalizeReferenceInput = (
    refTable: string,
    value: unknown,
    context: ReferenceContext,
  ): unknown => {
    if (value == null) return value;
    const assertReferenceTable = (incomingTable: string | null) => {
      if (incomingTable && incomingTable !== refTable) {
        throw adapterError(
          `Reference field "${context.field}" on model "${context.model}" expects a "${refTable}" record id, ` +
            `received "${incomingTable}".`,
        );
      }
    };
    if (value instanceof RecordId) {
      assertReferenceTable(value.table.name);
      return value;
    }
    const parsed = parseRecordIdLike(value);
    if (parsed) {
      assertReferenceTable(parsed.table);
      return new RecordId(refTable, toRecordIdPart(refTable, parsed.idComponent));
    }

    throw adapterError(
      `Reference field "${context.field}" on model "${context.model}" requires a record id-compatible value` +
        `${context.operator ? ` for operator "${context.operator}"` : ""}.`,
    );
  };

  /** Converts record-id-like values back to Better Auth logical ids. */
  const stripRecordPrefix = (value: unknown): unknown =>
    value instanceof RecordId || value instanceof StringRecordId || typeof value === "string"
      ? (parseRecordIdLike(value)?.idComponent ?? value)
      : value;
  return { toRecordId, normalizeReferenceInput, stripRecordPrefix };
};
