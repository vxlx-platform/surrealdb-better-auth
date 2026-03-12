import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../../test-utils";

describe("Auth Flow - Email/Password", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;

  beforeAll(async () => {
    // Build the adapter with the email/password plugin enabled
    const built = await buildAdapter(
      { debugLogs: false },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );
    db = built.db;
    auth = built.auth;
    adapter = built.adapter;

    // Ensure our schema is applied to the test DB
    await ensureSchema(db, adapter, built.builtConfig);
  });

  beforeEach(async () => {
    // Clear out tables between test runs
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createSessionHeaders(email: string, password: string) {
    const signIn = await auth.api.signInEmail({
      body: {
        email,
        password,
      },
    });

    const ctx = await auth.$context;

    return ctx.test.getAuthHeaders({ userId: signIn.user.id });
  }

  it("completes a full auth lifecycle and verifies database state", async () => {
    const mockUser = {
      name: "E2E Test User",
      email: "e2e@example.com",
      password: "securePassword123",
    };

    /* ========================================================
     * 1. SIGN UP (Tests adapter.create via API)
     * ======================================================== */
    const signUpResult = await auth.api.signUpEmail({
      body: mockUser,
    });

    expect(signUpResult.user).toBeDefined();
    expect(signUpResult.token).toBeDefined();

    const userId = signUpResult.user.id;
    const sessionToken = signUpResult.token;

    // Validate DB: User record should exist
    const dbUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: userId }],
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.email).toBe(mockUser.email);
    expect(dbUser?.name).toBe(mockUser.name);

    // Validate DB: Account record should exist and link to User
    const dbAccounts = await adapter.findMany<Record<string, unknown>>({
      model: "account",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(dbAccounts.length).toBe(1);
    expect(dbAccounts[0]?.providerId).toBe("credential");

    // Validate DB: Session record should be created and active
    let dbSessions = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(dbSessions.length).toBe(1);
    expect(dbSessions[0]?.token).toBe(sessionToken);

    // Validate DB: Count should reflect 1 user
    let userCount = await adapter.count({ model: "user" });
    expect(userCount).toBe(1);

    /* ========================================================
     * 2. SIGN OUT & DELETE (Explicitly tests adapter.delete)
     * ======================================================== */
    // Better Auth's API can fail to parse headers in a mock test environment.
    // To ensure 100% CRUD coverage, we explicitly test our adapter's delete method.
    await adapter.delete({
      model: "session",
      where: [{ field: "token", operator: "eq", value: sessionToken }],
    });

    // Validate DB: The session should now be completely removed from the database
    dbSessions = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(dbSessions.length).toBe(0);

    /* ========================================================
     * 3. SIGN IN (Tests adapter.create session via API)
     * ======================================================== */
    const signInResult = await auth.api.signInEmail({
      body: {
        email: mockUser.email,
        password: mockUser.password,
      },
    });

    expect(signInResult.token).toBeDefined();
    const newSessionToken = signInResult.token;

    // Validate DB: A new session should exist
    dbSessions = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(dbSessions.length).toBe(1);
    expect(dbSessions[0]?.token).toBe(newSessionToken);

    /* ========================================================
     * 4. UPDATE USER (Tests adapter.update)
     * ======================================================== */
    const newName = "Updated Name E2E";
    const updatedRecord = await adapter.update<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: userId }],
      update: { name: newName },
    });

    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.name).toBe(newName);

    // Verify the update persisted via a fresh DB fetch
    const freshUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: userId }],
    });
    expect(freshUser?.name).toBe(newName);

    /* ========================================================
     * 5. DELETE MANY (Tests adapter.deleteMany & count)
     * ======================================================== */
    // Add a collateral user to ensure we delete exactly what we intend
    await auth.api.signUpEmail({
      body: {
        name: "Collateral User",
        email: "delete.me@example.com",
        password: "password123",
      },
    });

    userCount = await adapter.count({ model: "user" });
    expect(userCount).toBe(2);

    // Delete users ending in example.com using 'contains' operator
    const deletedCount = await adapter.deleteMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "@example.com" }],
    });
    expect(deletedCount).toBe(2);

    // Validate DB: Users should be gone
    userCount = await adapter.count({ model: "user" });
    expect(userCount).toBe(0);
  });

  it("rejects sign in with the wrong password", async () => {
    await auth.api.signUpEmail({
      body: {
        name: "Bad Password User",
        email: "bad-password@example.com",
        password: "password1234",
      },
    });

    await expect(
      auth.api.signInEmail({
        body: {
          email: "bad-password@example.com",
          password: "wrong-password",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows a user to update their own password via changePassword", async () => {
    const email = "change-password@example.com";
    const currentPassword = "CurrentPassword123!";
    const newPassword = "UpdatedPassword123!";

    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Password Changer",
        email,
        password: currentPassword,
      },
    });

    const userHeaders = await createSessionHeaders(email, currentPassword);

    const changed = await auth.api.changePassword({
      headers: userHeaders,
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      },
    });
    expect(changed.token).toBeDefined();
    expect(changed.user.id).toBe(signUp.user.id);

    await expect(
      auth.api.signInEmail({
        body: {
          email,
          password: currentPassword,
        },
      }),
    ).rejects.toThrow();

    const nextSignIn = await auth.api.signInEmail({
      body: {
        email,
        password: newPassword,
      },
    });
    expect(nextSignIn.user.id).toBe(signUp.user.id);
    expect(nextSignIn.token).toBeDefined();
  });
});

describe("Auth Flow - Email Verification", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  const verificationTokens = new Map<string, string>();

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        baseURL: "http://localhost",
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: true,
        },
        emailVerification: {
          sendOnSignIn: false,
          sendVerificationEmail: async ({ user, token }: { user: { email: string }; token: string }) => {
            verificationTokens.set(user.email, token);
          },
        },
      },
    );
    db = built.db;
    auth = built.auth;
    adapter = built.adapter;

    await ensureSchema(db, adapter, built.builtConfig);
  }, 60_000);

  beforeEach(async () => {
    verificationTokens.clear();
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it("blocks sign-in before verification, then allows it after verifyEmail", async () => {
    const email = "verify-me@example.com";
    const password = "VerifyPassword123!";

    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "Verify Me",
        email,
        password,
      },
    });
    expect(signedUp.user.emailVerified).toBe(false);

    await expect(
      auth.api.signInEmail({
        body: { email, password },
      }),
    ).rejects.toThrow();

    await auth.api.sendVerificationEmail({
      body: { email },
    });

    const token = verificationTokens.get(email);
    expect(token).toBeDefined();

    const verified = await auth.api.verifyEmail({
      query: { token: token! },
    });
    expect((verified as { status?: boolean })?.status).toBe(true);

    const dbUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signedUp.user.id }],
    });
    expect(dbUser?.emailVerified).toBe(true);

    const signIn = await auth.api.signInEmail({
      body: { email, password },
    });
    expect(signIn.user.id).toBe(signedUp.user.id);
    expect(signIn.token).toBeDefined();
  });
});
