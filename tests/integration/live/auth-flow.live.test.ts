import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setCookieToHeader } from "better-auth/cookies";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/test-server";
import type { RunningTestServer } from "../../__helpers__/test-server";

describe("Live DB - Better Auth Email/Password Flow", () => {
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

  it("supports getSession and signOut lifecycle with cookie headers", async () => {
    const context = requireContext();
    const email = "live-session@example.com";
    const password = "live-session-password";

    const signUpResponse = await context.auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "Live Session User",
      },
      asResponse: true,
    });

    const headers = new Headers();
    setCookieToHeader(headers)({ response: signUpResponse });

    const session = await context.auth.api.getSession({ headers });
    expect(session?.user.id).toMatch(/^user:/);
    expect(session?.user.email).toBe(email);
    expect(session?.session.userId).toBe(session?.user.id);

    const signOutResponse = await context.auth.api.signOut({
      headers,
      asResponse: true,
    });
    setCookieToHeader(headers)({ response: signOutResponse });

    const afterSignOut = await context.auth.api.getSession({ headers });
    expect(afterSignOut).toBeNull();
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
});
