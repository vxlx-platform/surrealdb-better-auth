import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailOTP } from "better-auth/plugins";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type EmailOtpApi = {
  signUpEmail: (input: {
    body: { name: string; email: string; password: string };
  }) => Promise<{ user: { id: string; email: string } }>;
  sendVerificationOTP: (input: {
    body: {
      email: string;
      type: "sign-in" | "email-verification" | "forget-password" | "change-email";
    };
  }) => Promise<{ status?: boolean }>;
  signInEmailOTP: (input: {
    body: {
      email: string;
      otp: string;
      name?: string;
    };
  }) => Promise<{ token?: string; user: { id: string; email: string; emailVerified?: boolean } }>;
};

const asEmailOtpApi = (value: unknown): EmailOtpApi => value as EmailOtpApi;

const requireGetOTP = (context: AuthContext) => {
  const getOTP = context.test.getOTP;
  if (!getOTP) {
    throw new Error("Better Auth testUtils captureOTP helper is unavailable.");
  }
  return getOTP;
};

describe("Plugin - Email OTP", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live email-otp context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [
        emailOTP({
          sendVerificationOTP: async () => {},
        }),
      ],
    });
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("signs in an existing user with a valid sign-in OTP", async () => {
    const context = requireContext();
    const api = asEmailOtpApi(context.auth.api);
    const getOTP = requireGetOTP(context);
    const email = "otp-existing@example.com";
    const password = "Password1234!";

    const signedUp = await api.signUpEmail({
      body: {
        name: "OTP Existing",
        email,
        password,
      },
    });

    await api.sendVerificationOTP({
      body: {
        email,
        type: "sign-in",
      },
    });

    const otp = getOTP(email);
    expect(otp).toBeDefined();

    const signIn = await api.signInEmailOTP({
      body: {
        email,
        otp: otp!,
      },
    });

    expect(signIn.token).toBeDefined();
    expect(signIn.user.id).toBe(signedUp.user.id);

    const updatedUser = await context.adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signedUp.user.id }],
    });
    expect(updatedUser?.emailVerified).toBe(true);
  });

  it("creates a new user when signing in with OTP for an unregistered email", async () => {
    const context = requireContext();
    const api = asEmailOtpApi(context.auth.api);
    const getOTP = requireGetOTP(context);
    const email = "otp-new-user@example.com";

    await api.sendVerificationOTP({
      body: {
        email,
        type: "sign-in",
      },
    });

    const otp = getOTP(email);
    expect(otp).toBeDefined();

    const signIn = await api.signInEmailOTP({
      body: {
        email,
        otp: otp!,
        name: "OTP New User",
      },
    });

    expect(signIn.token).toBeDefined();
    expect(signIn.user.email).toBe(email);
    expect(signIn.user.emailVerified).toBe(true);

    const created = await context.adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signIn.user.id }],
    });
    expect(created).not.toBeNull();
    expect(created?.email).toBe(email);
    expect(created?.emailVerified).toBe(true);
  });
});
