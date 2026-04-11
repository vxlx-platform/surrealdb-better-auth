import { randomUUID } from "node:crypto";

import { Surreal } from "surrealdb";

const AUTH_TABLES = ["user", "session", "account", "verification"] as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const parseTimeoutMs = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const runtimeConfig = {
  endpoint: process.env.SURREALDB_TEST_ENDPOINT?.trim() || "ws://127.0.0.1:8000/rpc",
  username: process.env.SURREALDB_TEST_USERNAME?.trim() ?? "root",
  password: process.env.SURREALDB_TEST_PASSWORD?.trim() ?? "root",
  namespace: process.env.SURREALDB_TEST_NAMESPACE?.trim() || "main",
  database: process.env.SURREALDB_TEST_DATABASE?.trim() || "main",
  isolate: process.env.SURREALDB_TEST_ISOLATE === "1",
  connectTimeoutMs: parseTimeoutMs(
    process.env.SURREALDB_TEST_CONNECT_TIMEOUT_MS?.trim(),
    DEFAULT_CONNECT_TIMEOUT_MS,
  ),
};

export type LiveDbConnection = {
  db: Surreal;
  endpoint: string;
  namespace: string;
  database: string;
  closeDb: () => Promise<true>;
};

const createScopedName = (prefix: string) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  return `${prefix}_${suffix}`;
};

const resolveTestName = (configured: string | undefined, fallback: string, prefix: string) => {
  const base = configured ?? fallback;
  return runtimeConfig.isolate ? createScopedName(`${prefix}_${base}`) : base;
};

const withConnectionStepTimeout = async <T>(step: string, operation: Promise<T>) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              [
                `[tests] Timed out after ${runtimeConfig.connectTimeoutMs}ms while ${step}.`,
                `endpoint=${runtimeConfig.endpoint}`,
                `username=${runtimeConfig.username}`,
                "Make sure SurrealDB is running and the SURREALDB_TEST_* environment variables are correct.",
              ].join(" "),
            ),
          );
        }, runtimeConfig.connectTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

export async function truncateAuthTables(db: Surreal) {
  for (const table of AUTH_TABLES) {
    try {
      await db.query(`DELETE ${table};`);
    } catch {
      // Ignore missing table/schema errors during setup.
    }
  }
}

export async function createTestDbConnection(): Promise<LiveDbConnection> {
  const namespace = resolveTestName(runtimeConfig.namespace, "test", "ba_ns");
  const database = resolveTestName(runtimeConfig.database, "test", "ba_db");

  const db = new Surreal();
  try {
    await withConnectionStepTimeout(
      "connecting to SurrealDB",
      db.connect(runtimeConfig.endpoint),
    );
    await withConnectionStepTimeout(
      "signing in to SurrealDB",
      db.signin({ username: runtimeConfig.username, password: runtimeConfig.password }),
    );
    await withConnectionStepTimeout(
      `selecting namespace/database "${namespace}/${database}"`,
      db.use({ namespace, database }),
    );
  } catch (error) {
    try {
      await db.close();
    } catch {
      // Ignore close errors when setup already failed.
    }
    throw error;
  }

  return {
    db,
    endpoint: runtimeConfig.endpoint,
    namespace,
    database,
    closeDb: async () => {
      await db.close();
      return true as const;
    },
  };
}
