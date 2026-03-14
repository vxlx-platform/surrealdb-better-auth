import { randomUUID } from "node:crypto";

import { Surreal } from "surrealdb";

const AUTH_TABLES = ["user", "session", "account", "verification"] as const;

const runtimeConfig = {
  endpoint: process.env.SURREALDB_TEST_ENDPOINT?.trim() || "ws://localhost:8000/rpc",
  username: process.env.SURREALDB_TEST_USERNAME?.trim() ?? "root",
  password: process.env.SURREALDB_TEST_PASSWORD?.trim() ?? "root",
  namespace: process.env.SURREALDB_TEST_NAMESPACE?.trim() || "main",
  database: process.env.SURREALDB_TEST_DATABASE?.trim() || "main",
  isolate: process.env.SURREALDB_TEST_ISOLATE === "1",
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
  await db.connect(runtimeConfig.endpoint);
  await db.signin({ username: runtimeConfig.username, password: runtimeConfig.password });
  await db.use({ namespace, database });

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
