import { setCookieToHeader } from "better-auth/cookies";
import { oneTimeToken } from "better-auth/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/server";

type SignUpResponse = {
  token?: string;
  user: {
    id: string;
    email: string;
  };
};

type OneTimeTokenApi = {
  generateOneTimeToken: (input: { headers: Headers }) => Promise<{ token: string }>;
  verifyOneTimeToken: (input: {
    body: { token: string };
    asResponse?: boolean;
  }) => Promise<
    | {
        session: {
          id: string;
          token: string;
          userId: string;
        };
        user: {
          id: string;
          email: string;
        };
      }
    | Response
  >;
};

type VerificationRow = {
  identifier: string;
  value: string;
};

const asOneTimeTokenApi = (value: unknown): OneTimeTokenApi => value as OneTimeTokenApi;

const getCookieHeader = (response: Response) => {
  const responseHeaders = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = responseHeaders.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies
      .map((cookie) => cookie.split(";")[0] ?? "")
      .filter((cookie) => cookie.length > 0)
      .join("; ");
  }
  const single = response.headers.get("set-cookie");
  return single ? (single.split(";")[0] ?? "") : "";
};

const signUpAndGetSession = async (context: AuthContext, email: string) => {
  const response = await context.auth.api.signUpEmail({
    body: {
      email,
      password: "one-time-token-password",
      name: "One-Time Token User",
    },
    asResponse: true,
  });

  const body = (await response.json()) as SignUpResponse;
  const headers = new Headers();
  setCookieToHeader(headers)({ response });

  const sessions = await context.adapter.findMany<Record<string, unknown>>({
    model: "session",
    where: [{ field: "userId", operator: "eq", value: body.user.id }],
  });
  const session = sessions[0] as { token?: string } | undefined;
  if (!session?.token) {
    throw new Error("Expected a persisted session for the signed-up user.");
  }

  return {
    response,
    headers,
    user: body.user,
    sessionToken: session.token,
  };
};

describe("Plugin - One-Time Token", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live one-time-token context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [oneTimeToken()],
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

  it("generates a one-time token, stores a verification row, and consumes it on verify", async () => {
    const context = requireContext();
    const api = asOneTimeTokenApi(context.auth.api);
    const { headers, user, sessionToken } = await signUpAndGetSession(
      context,
      "ott-default@example.com",
    );

    const generated = await api.generateOneTimeToken({ headers });
    expect(generated.token).toBeTypeOf("string");
    expect(generated.token.length).toBeGreaterThan(0);

    const stored = await context.adapter.findOne<VerificationRow>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: `one-time-token:${generated.token}` }],
    });
    expect(stored?.identifier).toBe(`one-time-token:${generated.token}`);
    expect(stored?.value).toBe(sessionToken);

    const verified = (await api.verifyOneTimeToken({
      body: { token: generated.token },
    })) as {
      session: { token: string; userId: string };
      user: { id: string; email: string };
    };
    expect(verified.user.id).toBe(user.id);
    expect(verified.user.email).toBe(user.email);
    expect(verified.session.token).toBe(sessionToken);

    const removed = await context.adapter.findOne<VerificationRow>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: `one-time-token:${generated.token}` }],
    });
    expect(removed).toBeNull();

    const secondVerify = (await api.verifyOneTimeToken({
      body: { token: generated.token },
      asResponse: true,
    })) as Response;
    expect(secondVerify.status).toBe(400);
    expect(JSON.stringify(await secondVerify.json()).toLowerCase()).toMatch(/invalid token/);
  });

  it("supports custom token storage hashing", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        oneTimeToken({
          storeToken: {
            type: "custom-hasher",
            hash: async (token) => `hashed:${token}`,
          },
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asOneTimeTokenApi(customContext.auth.api);
      const { headers, sessionToken } = await signUpAndGetSession(
        customContext,
        "ott-custom-hash@example.com",
      );

      const generated = await api.generateOneTimeToken({ headers });

      const plainStored = await customContext.adapter.findOne<VerificationRow>({
        model: "verification",
        where: [{ field: "identifier", operator: "eq", value: `one-time-token:${generated.token}` }],
      });
      expect(plainStored).toBeNull();

      const hashedStored = await customContext.adapter.findOne<VerificationRow>({
        model: "verification",
        where: [
          {
            field: "identifier",
            operator: "eq",
            value: `one-time-token:hashed:${generated.token}`,
          },
        ],
      });
      expect(hashedStored?.value).toBe(sessionToken);

      const verified = (await api.verifyOneTimeToken({
        body: { token: generated.token },
      })) as {
        session: { token: string };
      };
      expect(verified.session.token).toBe(sessionToken);
    } finally {
      await customContext.closeDb();
    }
  });

  it("rejects client requests when disableClientRequest is enabled", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        oneTimeToken({
          disableClientRequest: true,
        }),
      ],
    });
    const server = await startTestServer(customContext.auth);

    try {
      await customContext.reset();
      const { response } = await signUpAndGetSession(customContext, "ott-disabled-client@example.com");
      const cookieHeader = getCookieHeader(response);
      expect(cookieHeader.length).toBeGreaterThan(0);

      const generateResponse = await fetch(server.url("/api/auth/one-time-token/generate"), {
        headers: {
          cookie: cookieHeader,
        },
        signal: AbortSignal.timeout(5_000),
      });
      expect(generateResponse.status).toBe(400);
      expect(JSON.stringify(await generateResponse.json()).toLowerCase()).toMatch(/disabled/);
    } finally {
      await server.stop();
      await customContext.closeDb();
    }
  });

  it("sets an OTT header on new sessions when configured", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        oneTimeToken({
          setOttHeaderOnNewSession: true,
          generateToken: async () => "fixed-ott-token",
        }),
      ],
    });

    try {
      await customContext.reset();
      const response = await customContext.auth.api.signUpEmail({
        body: {
          email: "ott-header@example.com",
          password: "ott-header-password",
          name: "OTT Header User",
        },
        asResponse: true,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-ott")).toBe("fixed-ott-token");
      expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
        "set-ott",
      );

      const stored = await customContext.adapter.findOne<VerificationRow>({
        model: "verification",
        where: [{ field: "identifier", operator: "eq", value: "one-time-token:fixed-ott-token" }],
      });
      expect(stored).not.toBeNull();
    } finally {
      await customContext.closeDb();
    }
  });
});
