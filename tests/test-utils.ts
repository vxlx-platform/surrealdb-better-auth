import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { Surreal } from "surrealdb";

import { surrealAdapter, type SurrealAdapterConfig } from "../src";

function getTestDbScope() {
  const fixedNamespace = process.env.SURREALDB_TEST_NAMESPACE ?? "main";
  const fixedDatabase = process.env.SURREALDB_TEST_DATABASE ?? "main";
  const isolate = process.env.SURREALDB_TEST_ISOLATE === "1";

  if (!isolate) {
    return {
      namespace: fixedNamespace,
      database: fixedDatabase,
    };
  }

  // Optional worker isolation for parallel test runs.
  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "local";
  return {
    namespace: `${fixedNamespace}_${workerId}`,
    database: `${fixedDatabase}_${workerId}`,
  };
}

export async function createTestDb() {
  const db = new Surreal();
  const { namespace, database } = getTestDbScope();
  await db.connect("ws://localhost:8000/rpc");
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace, database });
  return { db };
}

export async function buildAdapter(
  options?: SurrealAdapterConfig,
  authOptions?: Partial<BetterAuthOptions>,
) {
  const { db } = await createTestDb();
  const auth = betterAuth({
    ...authOptions,
    database: surrealAdapter(db, options),
  });

  const builtConfig = auth.options as BetterAuthOptions;
  const adapterFactory = builtConfig.database as DBAdapterInstance;
  const adapter = adapterFactory({
    plugins: builtConfig.plugins,
  }) as DBAdapter;

  return { db, auth, adapter, builtConfig };
}

export async function ensureSchema(
  db: Surreal,
  adapter: DBAdapter,
  builtConfig: BetterAuthOptions,
) {
  const result = await adapter.createSchema!(builtConfig, "");

  if (!result?.code) return;

  try {
    await db.query(result.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }
}

export async function truncateAuthTables(db: Surreal) {
  for (const table of ["session", "account", "verification", "user"]) {
    try {
      await db.query(`DELETE ${table}`);
    } catch {
      // Ignore missing table errors when schema has not been applied yet.
    }
  }
}
