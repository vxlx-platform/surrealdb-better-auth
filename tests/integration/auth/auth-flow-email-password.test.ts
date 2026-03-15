import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setCookieToHeader } from "better-auth/cookies";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/server";
import type { RunningTestServer } from "../../__helpers__/server";

describe("Auth Flow - Email/Password", () => {
  let context: AuthContext | undefined;
  let server: RunningTestServer | undefined;
  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live auth context was not initialized.");
    }
    return context;
  };
  const requireServer = (): RunningTestServer => {
    if (!server) {
      throw new Error("Live test server was not initialized.");
    }
    return server;
  };

  const createSessionHeaders = async (email: string, password: string) => {
    const context = requireContext();
    const signInResponse = await context.auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const headers = new Headers();
    setCookieToHeader(headers)({ response: signInResponse });
    return headers;
  };

  beforeAll(async () => {
    context = await setupAuthContext();
    server = await startTestServer(context.auth);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  it("supports sign-up and sign-in while persisting user/session rows", async () => {
    const context = requireContext();
    const server = requireServer();
    const email = "live-auth@example.com";
    const password = "live-auth-password";

    const healthResponse = await fetch(server.url("/health"));
    expect(healthResponse.status).toBe(200);

    const signUp = await context.auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "Live Auth User",
      },
    });

    expect(signUp.user.id).toMatch(/^user:/);
    expect(signUp.user.email).toBe(email);

    const sessionsAfterSignUp = await context.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: signUp.user.id }],
    });
    expect(sessionsAfterSignUp.length).toBeGreaterThanOrEqual(1);

    const signIn = await context.auth.api.signInEmail({
      body: {
        email,
        password,
      },
    });

    expect(signIn.user.id).toBe(signUp.user.id);
    expect(signIn.user.email).toBe(email);

    await expect(
      context.auth.api.signInEmail({
        body: {
          email,
          password: "invalid-password",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate email sign-up with a unique constraint error", async () => {
    const context = requireContext();
    const email = "live-duplicate@example.com";

    await context.auth.api.signUpEmail({
      body: {
        email,
        password: "first-password",
        name: "First User",
      },
    });

    await expect(
      context.auth.api.signUpEmail({
        body: {
          email,
          password: "second-password",
          name: "Second User",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows a user to update their own password via changePassword", async () => {
    const context = requireContext();
    const api = context.auth.api as unknown as {
      changePassword: (input: {
        headers: Headers;
        body: {
          currentPassword: string;
          newPassword: string;
          revokeOtherSessions?: boolean;
        };
      }) => Promise<{ token?: string; user: { id: string } }>;
    };

    const email = "change-password@example.com";
    const currentPassword = "CurrentPassword123!";
    const newPassword = "UpdatedPassword123!";

    const signUp = await context.auth.api.signUpEmail({
      body: {
        name: "Password Changer",
        email,
        password: currentPassword,
      },
    });

    const userHeaders = await createSessionHeaders(email, currentPassword);
    const changed = await api.changePassword({
      headers: userHeaders,
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      },
    });
    expect(changed.user.id).toBe(signUp.user.id);
    expect(changed.token).toBeDefined();

    await expect(
      context.auth.api.signInEmail({
        body: {
          email,
          password: currentPassword,
        },
      }),
    ).rejects.toThrow();

    const nextSignIn = await context.auth.api.signInEmail({
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
  let context: AuthContext | undefined;
  const verificationTokens = new Map<string, string>();

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live verification context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
      },
      emailVerification: {
        sendOnSignIn: false,
        sendVerificationEmail: async ({
          user,
          token,
        }: {
          user: { email: string };
          token: string;
        }) => {
          verificationTokens.set(user.email, token);
        },
      },
    });
  });

  beforeEach(async () => {
    verificationTokens.clear();
    await requireContext().reset();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("blocks sign-in before verification, then allows it after verifyEmail", async () => {
    const context = requireContext();
    const api = context.auth.api as unknown as {
      sendVerificationEmail: (input: { body: { email: string } }) => Promise<unknown>;
      verifyEmail: (input: { query: { token: string } }) => Promise<{ status?: boolean }>;
    };

    const email = "verify-me@example.com";
    const password = "VerifyPassword123!";

    const signedUp = await context.auth.api.signUpEmail({
      body: {
        name: "Verify Me",
        email,
        password,
      },
    });
    expect(signedUp.user.emailVerified).toBe(false);

    await expect(
      context.auth.api.signInEmail({
        body: { email, password },
      }),
    ).rejects.toThrow();

    await api.sendVerificationEmail({
      body: { email },
    });

    const token = verificationTokens.get(email);
    expect(token).toBeDefined();

    const verified = await api.verifyEmail({
      query: { token: token! },
    });
    expect(verified.status).toBe(true);

    const dbUser = await context.adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signedUp.user.id }],
    });
    expect(dbUser?.emailVerified).toBe(true);

    const signIn = await context.auth.api.signInEmail({
      body: { email, password },
    });
    expect(signIn.user.id).toBe(signedUp.user.id);
    expect(signIn.token).toBeDefined();
  });
});
