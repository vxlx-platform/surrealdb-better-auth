import type { DBAdapter } from "@better-auth/core/db/adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupIntegrationAdapter } from "../../test-utils";

const _getAuthType = () =>
  betterAuth({
    database: {} as any,
    emailAndPassword: { enabled: true },
    plugins: [
      emailOTP({
        sendVerificationOTP: async () => {},
      }),
    ],
  });

type AuthWithEmailOTP = ReturnType<typeof _getAuthType>;

describe("Plugin - Email OTP", () => {
  let db: Surreal;
  let auth: AuthWithEmailOTP;
  let adapter: DBAdapter;
  let resetDb: () => Promise<void>;
  let closeDb: () => Promise<true>;
  const otpByKey = new Map<string, string>();

  const otpKey = (
    email: string,
    type: "sign-in" | "email-verification" | "forget-password" | "change-email",
  ) => `${type}:${email.toLowerCase()}`;

  beforeAll(async () => {
    const built = await setupIntegrationAdapter(
      { debugLogs: false },
      {
        emailAndPassword: { enabled: true },
        plugins: [
          emailOTP({
            sendVerificationOTP: async ({ email, otp, type }) => {
              otpByKey.set(otpKey(email, type), otp);
            },
          }),
        ],
      },
    );
    db = built.db;
    auth = built.auth as unknown as AuthWithEmailOTP;
    adapter = built.adapter;
    resetDb = built.reset;
    closeDb = built.close;
  }, 60_000);

  beforeEach(async () => {
    otpByKey.clear();
    await resetDb();
  });

  afterAll(async () => {
    if (db) await closeDb();
  });

  it("signs in an existing user with a valid sign-in OTP", async () => {
    const email = "otp-existing@example.com";
    const password = "Password1234!";

    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "OTP Existing",
        email,
        password,
      },
    });

    await auth.api.sendVerificationOTP({
      body: {
        email,
        type: "sign-in",
      },
    });

    const otp = otpByKey.get(otpKey(email, "sign-in"));
    expect(otp).toBeDefined();

    const signIn = await auth.api.signInEmailOTP({
      body: {
        email,
        otp: otp!,
      },
    });

    expect(signIn.token).toBeDefined();
    expect(signIn.user.id).toBe(signedUp.user.id);

    // For existing users, plugin updates emailVerified in DB before session creation,
    // but response user payload may reflect pre-update user object.
    const updatedUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signedUp.user.id }],
    });
    expect(updatedUser?.emailVerified).toBe(true);
  });

  it("creates a new user when signing in with OTP for an unregistered email", async () => {
    const email = "otp-new-user@example.com";

    await auth.api.sendVerificationOTP({
      body: {
        email,
        type: "sign-in",
      },
    });

    const otp = otpByKey.get(otpKey(email, "sign-in"));
    expect(otp).toBeDefined();

    const signIn = await auth.api.signInEmailOTP({
      body: {
        email,
        otp: otp!,
        name: "OTP New User",
      },
    });

    expect(signIn.token).toBeDefined();
    expect(signIn.user.email).toBe(email);
    expect(signIn.user.emailVerified).toBe(true);

    const created = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signIn.user.id }],
    });
    expect(created).not.toBeNull();
    expect(created?.email).toBe(email);
    expect(created?.emailVerified).toBe(true);
  });
});
