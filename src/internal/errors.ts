import {
  ConnectionUnavailableError,
  InvalidSessionError,
  MissingNamespaceDatabaseError,
  ServerError,
  SurrealError,
} from "surrealdb";

type AdapterErrorFactory = (message: string, cause?: unknown) => Error;
const FIELD_COERCION_RE = /Couldn't coerce value for field `([^`]+)`/i;
const UNIQUE_CONSTRAINT_RE = /unique|duplicate/i;
type QueryErrorClassification =
  | { kind: "field"; field: string }
  | { kind: "unique" }
  | { kind: "none" };

/** Classifies Surreal errors into adapter-facing categories for consistent error shaping. */
const classifyQueryError = (err: unknown): QueryErrorClassification => {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(FIELD_COERCION_RE);
  if (match) return { kind: "field", field: match[1]! };
  if (UNIQUE_CONSTRAINT_RE.test(msg) || (err instanceof ServerError && err.kind === "AlreadyExists"))
    return { kind: "unique" };
  return { kind: "none" };
};

/** Creates a shared query error wrapper with human-friendly adapter-level messages. */
export const createQueryErrorWrapper = (adapterError: AdapterErrorFactory) => {
  const MAP = new Map<any, string>([
    [ConnectionUnavailableError, "connection is unavailable. Ensure the client is connected"],
    [MissingNamespaceDatabaseError, "namespace/database is not selected. Call db.use(...) first"],
    [InvalidSessionError, "session is invalid. The active transaction/session may have been closed"],
  ]);

  return (err: unknown, ctx: string): never => {
    for (const [Cls, msg] of MAP) {
      if (err instanceof Cls) throw adapterError(`SurrealDB ${msg} while ${ctx}.`, err);
    }
    const classification = classifyQueryError(err);
    if (classification.kind === "field") throw adapterError(`Invalid value for field "${classification.field}" while ${ctx}.`, err);
    if (classification.kind === "unique") throw adapterError(`Unique constraint violation while ${ctx}.`, err);
    if (err instanceof SurrealError) throw adapterError(`SurrealDB error while ${ctx}: ${err.message}`, err);
    throw adapterError(`SurrealDB query failed while ${ctx}: ${err instanceof Error ? err.message : String(err)}`, err);
  };
};
