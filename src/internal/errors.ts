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
const classifyQueryError = (error: unknown): QueryErrorClassification => {
  const message = error instanceof Error ? error.message : String(error);
  const fieldCoercionMatch = message.match(FIELD_COERCION_RE);
  if (error instanceof ServerError) {
    if (fieldCoercionMatch) return { kind: "field", field: fieldCoercionMatch[1]! };
    if (error.kind === "AlreadyExists" || UNIQUE_CONSTRAINT_RE.test(error.message))
      return { kind: "unique" };
  }
  if (fieldCoercionMatch) return { kind: "field", field: fieldCoercionMatch[1]! };
  if (UNIQUE_CONSTRAINT_RE.test(message)) return { kind: "unique" };
  return { kind: "none" };
};

/** Creates a shared query error wrapper with human-friendly adapter-level messages. */
export const createQueryErrorWrapper = (adapterError: AdapterErrorFactory) => {
  return (error: unknown, context: string): never => {
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
    const classification = classifyQueryError(error);
    if (classification.kind === "field")
      throw adapterError(
        `Invalid value for field "${classification.field}" while ${context}.`,
        error,
      );
    if (classification.kind === "unique")
      throw adapterError(`Unique constraint violation while ${context}.`, error);
    if (error instanceof SurrealError)
      throw adapterError(`SurrealDB error while ${context}: ${error.message}`, error);
    throw adapterError(`SurrealDB query failed while ${context}: ${message}`, error);
  };
};
