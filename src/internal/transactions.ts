import type { AdapterFactoryOptions, DBTransactionAdapter } from "better-auth/adapters";
import { Features, Surreal, SurrealSession, UnsupportedFeatureError } from "surrealdb";

type AdapterErrorFactory = (message: string, cause?: unknown) => Error;
type TransactionMode = "auto" | boolean;
type TransactionExecutor = Exclude<
  NonNullable<AdapterFactoryOptions["config"]["transaction"]>,
  false
>;

/** Reads SDK feature flags when available (`null` means indeterminate). */
export const detectTransactionFeatureSupport = (db: Surreal): boolean | null => {
  if (typeof db.isFeatureSupported !== "function") return null;
  try {
    return db.isFeatureSupported(Features.Sessions) && db.isFeatureSupported(Features.Transactions);
  } catch {
    return null;
  }
};

/** Detects engines that expose session APIs but fail at runtime for session support. */
export const isUnsupportedSessionsFeatureError = (error: unknown): boolean => {
  if (error instanceof UnsupportedFeatureError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("does not support the feature") && msg.includes("sessions");
  }
  return false;
};

/** Builds the Better Auth `transaction` adapter hook with runtime fallback semantics. */
export const createTransactionExecutor = ({
  db,
  transactionMode,
  initialTransactionSupport,
  hasForkSessionMethod,
  adapterError,
  createRuntimeAdapter,
  runWithoutDatabaseTransaction,
}: {
  db: Surreal;
  transactionMode: TransactionMode;
  initialTransactionSupport: boolean | null;
  hasForkSessionMethod: boolean;
  adapterError: AdapterErrorFactory;
  createRuntimeAdapter: (
    queryClient: Pick<import("surrealdb").SurrealQueryable, "query">,
    transaction: AdapterFactoryOptions["config"]["transaction"],
  ) => DBTransactionAdapter;
  runWithoutDatabaseTransaction: <R>(
    callback: (trx: DBTransactionAdapter) => Promise<R>,
  ) => Promise<R>;
}): AdapterFactoryOptions["config"]["transaction"] => {
  const shouldEnableTransactionExecutor =
    transactionMode !== false &&
    (transactionMode === true || (hasForkSessionMethod && initialTransactionSupport !== false));

  if (!shouldEnableTransactionExecutor) {
    return false;
  }

  let runtimeTransactionDisabled = transactionMode !== true && initialTransactionSupport === false;
  let transactionExecutor: AdapterFactoryOptions["config"]["transaction"] = false;

  const executeWithSessionTransaction = async <R>(
    session: SurrealSession,
    callback: (trx: DBTransactionAdapter) => Promise<R>,
  ): Promise<R> => {
    const transaction = await session.beginTransaction();
    const adapter = createRuntimeAdapter(transaction, transactionExecutor);

    try {
      const result = await callback(adapter);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.cancel();
      } catch {
        // Keep the original callback/query failure when cancel also fails.
      }
      throw error;
    }
  };

  const transactionHandler: TransactionExecutor = async <R>(
    callback: (trx: DBTransactionAdapter) => Promise<R>,
  ): Promise<R> => {
    const fallback = () => runWithoutDatabaseTransaction(callback);
    const onUnsupported = (error: unknown, wrapperMessage?: string) => {
      if (isUnsupportedSessionsFeatureError(error) && transactionMode !== true) {
        runtimeTransactionDisabled = true;
        return fallback();
      }
      throw wrapperMessage ? adapterError(wrapperMessage, error) : error;
    };

    if (!hasForkSessionMethod) {
      if (transactionMode === true) {
        throw adapterError(
          "Transactions were explicitly enabled, but this SurrealDB client does not expose forkSession().",
        );
      }
      return fallback();
    }

    if (runtimeTransactionDisabled && transactionMode !== true) return fallback();

    let session: SurrealSession | null = null;
    try {
      session = await db.forkSession();
      return await executeWithSessionTransaction(session, callback);
    } catch (error) {
      return onUnsupported(
        error,
        !session ? "Failed to initialize a SurrealDB transaction session." : undefined,
      );
    } finally {
      await session?.closeSession();
    }
  };

  transactionExecutor = transactionHandler;
  return transactionExecutor;
};
