import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { Surreal } from "surrealdb";

import { surrealAdapter } from "../../src";
import { createTestDbConnection, truncateAuthTables } from "./db";

type SetupAuthContextOptions = {
  plugins?: BetterAuthOptions["plugins"];
};

const extractDefinedTables = (schemaCode: string): string[] => {
  const regex = /\bDEFINE\s+TABLE(?:\s+OVERWRITE)?\s+([A-Za-z0-9_]+)/gi;
  const tables = new Set<string>();
  for (const match of schemaCode.matchAll(regex)) {
    const table = match[1];
    if (table) tables.add(table);
  }
  return [...tables];
};

const recreateDefinedTables = async (db: Surreal, schemaCode: string) => {
  const tables = extractDefinedTables(schemaCode);
  for (const table of tables) {
    try {
      await db.query(`REMOVE TABLE ${table};`);
    } catch {
      // Ignore if table does not exist yet.
    }
  }
  await db.query(schemaCode);
};

const createAuth = (db: Surreal, options?: SetupAuthContextOptions) =>
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
    ...(options?.plugins ? { plugins: options.plugins } : {}),
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

export async function setupAuthContext(options?: SetupAuthContextOptions): Promise<AuthContext> {
  const { db, closeDb, namespace, database } = await createTestDbConnection();

  const auth = createAuth(db, options);

  const authOptions = auth.options as BetterAuthOptions;
  const adapterFactory = authOptions.database as DBAdapterInstance;
  const adapter = adapterFactory(authOptions) as DBAdapter;

  const schema = await adapter.createSchema?.(authOptions, ".better-auth/schema.surql");
  if (!schema?.code) {
    throw new Error("Adapter did not generate schema code for live tests.");
  }
  await recreateDefinedTables(db, schema.code);
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
