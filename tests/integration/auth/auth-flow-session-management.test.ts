import { setCookieToHeader } from "better-auth/cookies";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

describe("Auth Flow - Session Management", () => {
  let context: AuthContext | undefined;
  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live auth context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
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
});
