import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { Surreal } from "surrealdb";

import { surrealAdapter } from "../../src";
import { createTestDbConnection, hasLiveSurrealEndpoint, truncateAuthTables } from "./db";

export { hasLiveSurrealEndpoint };

const createAuth = (db: Surreal) =>
  betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "01234567890123456789012345678901",
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => password,
        verify: async ({ hash, password }) => hash === password,
      },
    },
    database: surrealAdapter(db),
  });

type Auth = ReturnType<typeof createAuth>;

export type AuthContext = {
  db: Surreal;
  auth: Auth;
  adapter: DBAdapter;
  namespace: string;
  database: string;
  reset: () => Promise<void>;
  closeDb: () => Promise<true>;
};

export async function setupAuthContext(): Promise<AuthContext> {
  const { db, closeDb, namespace, database } = await createTestDbConnection();

  const auth = createAuth(db);

  const options = auth.options as BetterAuthOptions;
  const adapterFactory = options.database as DBAdapterInstance;
  const adapter = adapterFactory(options) as DBAdapter;

  const schema = await adapter.createSchema?.(options, ".better-auth/schema.surql");
  if (!schema?.code) {
    throw new Error("Adapter did not generate schema code for live tests.");
  }
  await db.query(schema.code);
  await truncateAuthTables(db);

  return {
    db,
    auth,
    adapter,
    namespace,
    database,
    reset: async () => {
      await truncateAuthTables(db);
    },
    closeDb,
  };
}
