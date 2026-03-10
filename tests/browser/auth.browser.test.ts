import { describe, expect, it } from "vitest";

const expectOkJson = async (response: Response, context: string) => {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${context} failed with ${response.status} ${response.statusText}: ${body}`);
  }

  return response.json();
};

describe("Browser auth flows", () => {
  it("fetches /.well-known from a real browser context", async () => {
    const response = await fetch("/api/auth/.well-known", {
      signal: AbortSignal.timeout(5_000),
    });

    const jwks = (await expectOkJson(response, "Browser JWKS fetch")) as { keys: any[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("creates, clears, and restores session state through browser requests", async () => {
    const email = `browser-${Date.now()}@example.com`;
    const password = "browser-password-123";

    const signUpResponse = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Browser User",
        email,
        password,
      }),
      credentials: "include",
      signal: AbortSignal.timeout(5_000),
    });

    const signUp = (await expectOkJson(signUpResponse, "Browser sign-up")) as {
      user: { email: string };
    };
    expect(signUp.user.email).toBe(email);

    const sessionAfterSignUp = (await expectOkJson(
      await fetch("/api/auth/get-session", {
        credentials: "include",
        signal: AbortSignal.timeout(5_000),
      }),
      "Browser get-session after sign-up",
    )) as {
      user: { email: string };
    } | null;

    expect(sessionAfterSignUp?.user.email).toBe(email);

    await expectOkJson(
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.timeout(5_000),
      }),
      "Browser sign-out",
    );

    const sessionAfterSignOut = (await expectOkJson(
      await fetch("/api/auth/get-session", {
        credentials: "include",
        signal: AbortSignal.timeout(5_000),
      }),
      "Browser get-session after sign-out",
    )) as {
      user: { email: string };
    } | null;

    expect(sessionAfterSignOut).toBeNull();

    const signInResponse = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
      }),
      credentials: "include",
      signal: AbortSignal.timeout(5_000),
    });

    await expectOkJson(signInResponse, "Browser sign-in");

    const sessionAfterSignIn = (await expectOkJson(
      await fetch("/api/auth/get-session", {
        credentials: "include",
        signal: AbortSignal.timeout(5_000),
      }),
      "Browser get-session after sign-in",
    )) as {
      user: { email: string };
    } | null;

    expect(sessionAfterSignIn?.user.email).toBe(email);
  });
});
