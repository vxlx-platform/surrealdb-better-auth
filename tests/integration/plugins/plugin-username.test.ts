import type { DBAdapter } from "@better-auth/core/db/adapter";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../../test-utils";

// 1. Create a dummy auth configuration purely for strict type inference.
// We use 'as any' ONLY for the dummy database since it never runs.
const _getAuthType = () =>
  betterAuth({
    database: {} as any,
    emailAndPassword: {
      enabled: true,
    },
    plugins: [username()],
  });

// 2. Extract the exact type, which now natively includes `username` fields and endpoints!
type AuthWithUsername = ReturnType<typeof _getAuthType>;

describe("Plugin - Username", () => {
  let db: Surreal;
  // 3. Strongly type our test instance
  let auth: AuthWithUsername;
  let adapter: DBAdapter;

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        emailAndPassword: {
          enabled: true,
        },
        plugins: [username()],
      },
    );
    db = built.db;
    // 4. Safely cast the dynamically built auth to our strictly typed version
    auth = built.auth as unknown as AuthWithUsername;
    adapter = built.adapter;

    await ensureSchema(db, adapter, built.builtConfig);
  });

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it("signs up, saves username fields to the DB, and signs in successfully", async () => {
    const mockUser = {
      name: "Dan The Dev",
      email: "dan@example.com",
      password: "securePassword123",
      username: "Dan_Is_Cool", // No more TypeScript errors here!
    };

    /* ========================================================
     * 1. SIGN UP
     * ======================================================== */
    const signUpResult = await auth.api.signUpEmail({
      body: mockUser,
    });

    expect(signUpResult.user).toBeDefined();
    expect(signUpResult.user.username).toBe("dan_is_cool");

    const userId = signUpResult.user.id;

    const dbUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: userId }],
    });

    expect(dbUser).not.toBeNull();
    expect(dbUser?.username).toBe("dan_is_cool");
    expect(dbUser?.displayUsername).toBe("Dan_Is_Cool");

    /* ========================================================
     * 2. SIGN IN WITH USERNAME
     * ======================================================== */
    // TypeScript now explicitly knows signInUsername exists!
    const signInResult = await auth.api.signInUsername({
      body: {
        username: "dan_is_cool",
        password: mockUser.password,
      },
    });

    expect(signInResult.token).toBeDefined();
    expect(signInResult.user.id).toBe(userId);

    const dbSessions = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [
        { field: "userId", operator: "eq", value: userId },
        { field: "token", operator: "eq", value: signInResult.token },
      ],
    });

    expect(dbSessions.length).toBe(1);
  });

  it("correctly evaluates username availability", async () => {
    const existingUsername = "taken_username";

    await auth.api.signUpEmail({
      body: {
        name: "Test User",
        email: "taken@example.com",
        password: "password1234",
        username: existingUsername,
      },
    });

    // TypeScript knows about isUsernameAvailable
    const takenResponse = await auth.api.isUsernameAvailable({
      body: { username: existingUsername },
    });
    expect(takenResponse.available).toBe(false);

    const freeResponse = await auth.api.isUsernameAvailable({
      body: { username: "brand_new_username" },
    });
    expect(freeResponse.available).toBe(true);
  });

  it("rejects sign in with an incorrect username or password", async () => {
    await auth.api.signUpEmail({
      body: {
        name: "Test User",
        email: "user@example.com",
        password: "correct_password",
        username: "valid_username",
      },
    });

    await expect(
      auth.api.signInUsername({
        body: {
          username: "valid_username",
          password: "wrong_password",
        },
      }),
    ).rejects.toThrow();

    await expect(
      auth.api.signInUsername({
        body: {
          username: "invalid_username_that_does_not_exist",
          password: "correct_password",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces database-level unique constraints on the username field", async () => {
    await auth.api.signUpEmail({
      body: {
        name: "First User",
        email: "first@example.com",
        password: "password1234",
        username: "highly_coveted_username",
      },
    });

    await expect(
      auth.api.signUpEmail({
        body: {
          name: "Second User",
          email: "second@example.com",
          password: "password1234",
          username: "highly_coveted_username",
        },
      }),
    ).rejects.toThrow();

    const userCount = await adapter.count({ model: "user" });
    expect(userCount).toBe(1);
  });
});
