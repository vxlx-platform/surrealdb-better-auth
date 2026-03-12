import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";

describe("Verification token lifecycle", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  const resetTokens = new Map<string, string>();

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        baseURL: "http://localhost",
        emailAndPassword: {
          enabled: true,
          sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
            resetTokens.set(user.email.toLowerCase(), token);
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
    resetTokens.clear();
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it("creates, consumes, and invalidates reset-password verification tokens", async () => {
    const email = "reset-lifecycle@example.com";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword123!";

    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "Reset Lifecycle User",
        email,
        password: oldPassword,
      },
    });

    const requested = await auth.api.requestPasswordReset({
      body: {
        email,
      },
    });
    expect(requested.status).toBe(true);

    const token = resetTokens.get(email.toLowerCase());
    expect(token).toBeDefined();

    const identifier = `reset-password:${token!}`;

    const verificationBefore = await adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: identifier }],
    });
    expect(verificationBefore).not.toBeNull();
    expect(verificationBefore?.identifier).toBe(identifier);
    expect(verificationBefore?.value).toBe(signedUp.user.id);

    const reset = await auth.api.resetPassword({
      body: {
        token: token!,
        newPassword,
      },
    });
    expect(reset.status).toBe(true);

    const verificationAfter = await adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: identifier }],
    });
    expect(verificationAfter).toBeNull();

    await expect(
      auth.api.signInEmail({
        body: {
          email,
          password: oldPassword,
        },
      }),
    ).rejects.toThrow();

    const signIn = await auth.api.signInEmail({
      body: {
        email,
        password: newPassword,
      },
    });
    expect(signIn.user.id).toBe(signedUp.user.id);
    expect(signIn.token).toBeDefined();

    await expect(
      auth.api.resetPassword({
        body: {
          token: token!,
          newPassword: "AnotherPassword123!",
        },
      }),
    ).rejects.toThrow();
  });

  it("does not create a token for unknown users while returning success", async () => {
    const unknownEmail = "unknown-reset@example.com";

    const requested = await auth.api.requestPasswordReset({
      body: {
        email: unknownEmail,
      },
    });
    expect(requested.status).toBe(true);

    expect(resetTokens.get(unknownEmail.toLowerCase())).toBeUndefined();

    const verificationRows = await adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "contains", value: "reset-password:" }],
    });
    expect(verificationRows).toHaveLength(0);
  });
});
