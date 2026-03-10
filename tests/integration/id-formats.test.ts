import type { Surreal } from "surrealdb";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";

// Regex patterns for strict ID format validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// SurrealDB default random IDs are usually alphanumeric
const RANDOM_ID_REGEX = /^[a-zA-Z0-9]+$/;

describe("Record ID Formats Configuration", () => {
  let db: Surreal | undefined;

  beforeEach(async () => {
    // We handle truncation within the tests if db is initialized,
    // but the tests build their own adapters so we will truncate after build.
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = undefined;
    }
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it("should create records with a UUIDv7 format", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "uuidv7" },
      { emailAndPassword: { enabled: true } },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);
    await truncateAuthTables(db);

    const result = await auth.api.signUpEmail({
      body: {
        name: "UUID User",
        email: "uuid.user@example.com",
        password: "password1234",
      },
    });

    expect(result).not.toBeNull();

    // Validate the exact pattern of the ID returned to Better Auth
    expect(result.user.id).toMatch(UUID_REGEX);

    // Ensure the session ID also followed the global rule
    const session = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(session[0]!.id).toMatch(UUID_REGEX);
  });

  it("should create records with a ULID format", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "ulid" },
      { emailAndPassword: { enabled: true } },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);
    await truncateAuthTables(db);

    const result = await auth.api.signUpEmail({
      body: {
        name: "ULID User",
        email: "ulid@example.com",
        password: "password1234",
      },
    });

    expect(result).not.toBeNull();
    expect(result.user.id).toMatch(ULID_REGEX);

    const session = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(session[0]!.id).toMatch(ULID_REGEX);
  });

  it("should create records with the default random format", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "native" },
      { emailAndPassword: { enabled: true } },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);
    await truncateAuthTables(db);

    const result = await auth.api.signUpEmail({
      body: {
        name: "Random ID User",
        email: "random.id@example.com",
        password: "password1234",
      },
    });

    expect(result).not.toBeNull();

    // SurrealDB random IDs are typically 20 alphanumeric characters
    expect(result.user.id).toMatch(RANDOM_ID_REGEX);
    expect(result.user.id.length).toBeGreaterThanOrEqual(20);
  });

  it("should support table-specific format logic via a function", async () => {
    // We configure the adapter to use UUID for users, ULID for accounts, and random for everything else (sessions)
    const built = await buildAdapter(
      {
        recordIdFormat: (tableName) => {
          if (tableName === "user") return "uuidv7";
          if (tableName === "account") return "ulid";
          return "native";
        },
      },
      { emailAndPassword: { enabled: true } },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);
    await truncateAuthTables(db);

    const result = await auth.api.signUpEmail({
      body: {
        name: "Mixed ID User",
        email: "mixed.id@example.com",
        password: "password1234",
      },
    });

    expect(result).not.toBeNull();
    const userId = result.user.id;

    // 1. The User record should be a UUIDv7
    expect(userId).toMatch(UUID_REGEX);

    // 2. Fetch the linked Account record; it should be a ULID
    const accounts = await built.adapter.findMany<Record<string, unknown>>({
      model: "account",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id as string).toMatch(ULID_REGEX);

    // 3. Fetch the linked Session record; it should fall back to the random string
    const sessions = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toMatch(RANDOM_ID_REGEX);
    expect((sessions[0]!.id as string).length).toBeGreaterThanOrEqual(20);
  });
});
