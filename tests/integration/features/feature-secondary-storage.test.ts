import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { type Surreal, Table } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../../test-utils";

type CacheEntry = {
  value: string;
  expiresAt: number | null;
};

const createInMemorySecondaryStorage = () => {
  const entries = new Map<string, CacheEntry>();

  const read = (key: string): string | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry.value;
  };

  return {
    get: async (key: string) => read(key),
    set: async (key: string, value: string, ttl?: number) => {
      const expiresAt = typeof ttl === "number" && ttl > 0 ? Date.now() + ttl * 1000 : null;
      entries.set(key, { value, expiresAt });
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    keys: () => {
      const now = Date.now();
      return [...entries.entries()]
        .filter(([, entry]) => entry.expiresAt === null || entry.expiresAt > now)
        .map(([key]) => key);
    },
  };
};

describe("Feature - Secondary Storage Sessions", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  let builtConfig: BetterAuthOptions;
  const secondaryStorage = createInMemorySecondaryStorage();

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        baseURL: "http://localhost",
        emailAndPassword: {
          enabled: true,
        },
        session: {
          storeSessionInDatabase: false,
        },
        secondaryStorage,
      },
    );

    db = built.db;
    auth = built.auth;
    adapter = built.adapter;
    builtConfig = built.builtConfig;

    const schema = await adapter.createSchema!(builtConfig, "secondary-storage.surql");
    expect(schema.code).not.toContain("DEFINE TABLE session SCHEMAFULL;");
    expect(schema.code).toContain("DEFINE TABLE user SCHEMAFULL;");
    expect(schema.code).toContain("DEFINE TABLE account SCHEMAFULL;");

    await ensureSchema(db, adapter, builtConfig);
  }, 60_000);

  beforeEach(async () => {
    secondaryStorage.clear();
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it("keeps session state in secondary storage without persisting session rows in SurrealDB", async () => {
    const email = `secondary-storage-${Date.now()}@example.com`;
    const ctx = await auth.$context;
    const user = ctx.test.createUser({
      email,
      name: "Secondary Storage User",
    });
    const savedUser = await ctx.test.saveUser(user);
    const userId = savedUser.id;

    const sessionA = await ctx.test.login({ userId });
    const sessionB = await ctx.test.login({ userId });

    const listed = await auth.api.listSessions({
      headers: sessionA.headers as Headers,
    });

    const listedTokens = listed.map((session) => session.token);
    expect(listedTokens).toHaveLength(2);
    expect(new Set(listedTokens)).toEqual(new Set([sessionA.token, sessionB.token]));

    const secondaryKeys = secondaryStorage.keys();
    expect(secondaryKeys).toContain(sessionA.token);
    expect(secondaryKeys).toContain(sessionB.token);
    expect(secondaryKeys).toContain(`active-sessions-${userId}`);

    const rawSessions = (await db.select(new Table("session"))) as unknown[];
    expect(rawSessions).toHaveLength(0);
  });
});
