import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/server";
import type { RunningTestServer } from "../../__helpers__/server";

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

const decodeJwtHeader = (token: string): Record<string, unknown> => {
  const [header] = token.split(".");
  if (!header) {
    throw new Error("JWT header segment is missing.");
  }
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
};

const algorithms = [
  {
    alg: "EdDSA",
    keyPairConfig: {
      alg: "EdDSA",
      crv: "Ed25519",
    },
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
    },
  },
  {
    alg: "ES256",
    keyPairConfig: {
      alg: "ES256",
    },
    jwk: {
      kty: "EC",
      crv: "P-256",
    },
  },
  {
    alg: "RS256",
    keyPairConfig: {
      alg: "RS256",
      modulusLength: 2048,
    },
    jwk: {
      kty: "RSA",
    },
  },
] as const;

describe.each(algorithms)("Plugin - JWT Algorithms ($alg)", ({ alg, keyPairConfig, jwk }) => {
  let context: AuthContext | undefined;
  let server: RunningTestServer | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error(`JWT algorithm context was not initialized for "${alg}".`);
    }
    return context;
  };

  const requireServer = (): RunningTestServer => {
    if (!server) {
      throw new Error(`JWT algorithm server was not initialized for "${alg}".`);
    }
    return server;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [
        jwt({
          jwks: {
            jwksPath: "/.well-known/jwks.json",
            keyPairConfig,
          },
          jwt: {
            definePayload: (session) => ({
              exp: Math.floor(Date.now() / 1000) + 60 * 15,
              id: session.user.id,
              email: session.user.email,
            }),
            getSubject: (session) => session.user.id,
          },
        }),
      ],
    });
    server = await startTestServer(requireContext().auth);
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (context) {
      await context.closeDb();
    }
  });

  it("issues a JWT and exposes a matching JWKS key", async () => {
    const liveServer = requireServer();
    const email = `jwt-${alg.toLowerCase()}-${Date.now()}@example.com`;

    const signUpResponse = await requireContext().auth.api.signUpEmail({
      body: {
        name: `JWT ${alg}`,
        email,
        password: "jwt-algorithm-password",
      },
      asResponse: true,
    });
    expect(signUpResponse.status).toBe(200);

    const cookieHeader = getCookieHeader(signUpResponse);
    expect(cookieHeader.length).toBeGreaterThan(0);

    const tokenResponse = await fetch(liveServer.url("/api/auth/token"), {
      headers: {
        cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(5_000),
    });
    expect(tokenResponse.status).toBe(200);

    const tokenBody = (await tokenResponse.json()) as { token: string };
    expect(tokenBody.token.split(".")).toHaveLength(3);

    const header = decodeJwtHeader(tokenBody.token);
    expect(header.alg).toBe(alg);
    expect(typeof header.kid).toBe("string");

    const jwksResponse = await fetch(liveServer.url("/api/auth/.well-known/jwks.json"), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(jwksResponse.status).toBe(200);

    const jwks = (await jwksResponse.json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(jwks.keys.length).toBeGreaterThan(0);

    const matchingKey = jwks.keys.find((key) => key.kid === header.kid);
    expect(matchingKey).toBeDefined();
    expect(matchingKey?.alg).toBe(alg);
    expect(matchingKey?.kty).toBe(jwk.kty);

    if ("crv" in jwk) {
      expect(matchingKey?.crv).toBe(jwk.crv);
    }
    if (alg === "RS256") {
      expect(typeof matchingKey?.n).toBe("string");
      expect(typeof matchingKey?.e).toBe("string");
    }
  });

  it("adds jwks schema for the configured algorithm", async () => {
    const authOptions = requireContext().auth.options as BetterAuthOptions;
    const schema = await requireContext().adapter.createSchema?.(
      authOptions,
      `jwt-${alg.toLowerCase()}-schema.surql`,
    );

    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
  });
});
