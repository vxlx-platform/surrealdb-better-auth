import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Surreal } from "surrealdb";
import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

describe("id formats", () => {
  let db: Surreal;

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("should create a user record with a uuid id", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "uuidv7" },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);

    const mockUser = {
      name: "Test User",
      email: "test.user@example.com",
      password: "password1234",
    };

    const result = await auth.api.signUpEmail({
      body: {
        name: mockUser.name,
        email: mockUser.email,
        password: mockUser.password,
      },
    });

    // Check we get something back
    expect(result).not.toBeNull();

    // Verify values made it into the DB
    expect(typeof result.token).toBe("string");
    expect(result.user.email).toBe(mockUser.email);

    // UUID (v4/v7) is 36 chars (8-4-4-4-12)
    console.log("[Test Debug] Resulting UUID User ID:", result.user.id);
    expect(result.user.id.length).toBe(36);
  });

  it("should create a user record with a ulid id", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "ulid" },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);

    const mockUser = {
      name: "ULID User",
      email: "ulid@example.com",
      password: "password1234",
    };

    const result = await auth.api.signUpEmail({
      body: {
        name: mockUser.name,
        email: mockUser.email,
        password: mockUser.password,
      },
    });

    expect(result).not.toBeNull();
    expect(result.user.email).toBe(mockUser.email);

    // ULID is 26 chars
    console.log("[Test Debug] Resulting ULID User ID:", result.user.id);
    expect(result.user.id.length).toBe(26);
  });

  it("should create a user record with default random id format", async () => {
    const built = await buildAdapter(
      { recordIdFormat: "random" },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );
    db = built.db;
    const auth = built.auth;
    await ensureSchema(db, built.adapter, built.builtConfig);

    const mockUser = {
      name: "Random ID User",
      email: "random.id@example.com",
      password: "password1234",
    };

    const result = await auth.api.signUpEmail({
      body: {
        name: mockUser.name,
        email: mockUser.email,
        password: mockUser.password,
      },
    });

    expect(result).not.toBeNull();
    expect(result.user.email).toBe(mockUser.email);

    console.log("[Test Debug] Resulting Random User ID:", result.user.id);
    // SurrealDB default random IDs are 20 chars
    expect(result.user.id.length).toBe(20);
  });
});
