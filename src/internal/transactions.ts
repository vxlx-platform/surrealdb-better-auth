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

/** Detects engines that expose session APIs but fail at runtime for session support. */
export const isUnsupportedSessionsFeatureError = (error: unknown): boolean => {
  if (error instanceof UnsupportedFeatureError) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("does not support the feature") && message.includes("sessions");
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
    !(transactionMode === "auto" && (!hasForkSessionMethod || initialTransactionSupport === false));

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
    if (!hasForkSessionMethod) {
      if (transactionMode === true) {
        throw adapterError(
          "Transactions were explicitly enabled, but this SurrealDB client does not expose forkSession().",
        );
      }
      return runWithoutDatabaseTransaction(callback);
    }

    if (runtimeTransactionDisabled && transactionMode !== true) {
      return runWithoutDatabaseTransaction(callback);
    }

    let session: SurrealSession | null = null;

    try {
      session = await db.forkSession();
    } catch (error) {
      if (isUnsupportedSessionsFeatureError(error) && transactionMode !== true) {
        runtimeTransactionDisabled = true;
        return runWithoutDatabaseTransaction(callback);
      }
      throw adapterError("Failed to initialize a SurrealDB transaction session.", error);
    }

    try {
      return await executeWithSessionTransaction(session, callback);
    } catch (error) {
      if (isUnsupportedSessionsFeatureError(error) && transactionMode !== true) {
        runtimeTransactionDisabled = true;
        return runWithoutDatabaseTransaction(callback);
      }
      throw error;
    } finally {
      await session.closeSession();
    }
  };

  transactionExecutor = transactionHandler;
  return transactionExecutor;
};
