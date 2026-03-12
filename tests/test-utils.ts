import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { Surreal } from "surrealdb";

import { type SurrealAdapterConfig, executeSurqlSchema, surrealAdapter } from "../src";
import { AUTH_TABLES, truncateTables } from "./__helpers__/db";
import { getScopedDbName, getTestDbEnv } from "./__helpers__/env";

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

type TestOnlyAdapterConfig = SurrealAdapterConfig & {
  apiEndpoints?: boolean | { basePath?: string; models?: string[] };
};

export async function buildAdapter(
  options?: TestOnlyAdapterConfig,
  authOptions?: Partial<BetterAuthOptions>,
) {
  const { db } = await createTestDb();
  const inputPlugins = authOptions?.plugins ?? [];
  const hasTestUtils = inputPlugins.some(
    (plugin) => (plugin as { id?: string })?.id === "test-utils",
  );

  const auth = betterAuth({
    ...authOptions,
    plugins: hasTestUtils ? inputPlugins : [...inputPlugins, testUtils()],
    database: surrealAdapter(db, options as SurrealAdapterConfig | undefined),
  });

  const builtConfig = auth.options as BetterAuthOptions;
  const adapterFactory = builtConfig.database as DBAdapterInstance;
  const adapter = adapterFactory(builtConfig) as DBAdapter;

  return { db, auth, adapter, builtConfig };
}

export async function ensureSchema(
  db: Surreal,
  adapter: DBAdapter,
  builtConfig: BetterAuthOptions,
) {
  const result = await adapter.createSchema!(builtConfig, "");

  if (!result?.code) return;

  await executeSurqlSchema(db, result.code);
}

export async function truncateAuthTables(db: Surreal) {
  await truncateTables(db, AUTH_TABLES);
}
