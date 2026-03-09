import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { Surreal } from "surrealdb";

import { AUTH_TABLES, truncateTables } from "./__helpers__/db";
import { getScopedDbName, getTestDbEnv } from "./__helpers__/env";
import { surrealAdapter, type SurrealAdapterConfig } from "../src";

export async function createTestDb() {
  const env = getTestDbEnv();
  const db = new Surreal();
  await db.connect(env.endpoint);
  await db.signin({ username: env.username, password: env.password });
  await db.use({
    namespace: getScopedDbName(env.namespace),
    database: getScopedDbName(env.database),
  });
  return { db };
}

export async function buildAdapter(
  options?: SurrealAdapterConfig,
  authOptions?: Partial<BetterAuthOptions>,
) {
  const { db } = await createTestDb();
  const inputPlugins = authOptions?.plugins ?? [];
  const hasTestUtils = inputPlugins.some((plugin) => (plugin as { id?: string })?.id === "test-utils");

  const auth = betterAuth({
    ...authOptions,
    plugins: hasTestUtils ? inputPlugins : [...inputPlugins, testUtils()],
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
  await truncateTables(db, AUTH_TABLES);
}
