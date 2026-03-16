import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Surreal, escapeIdent, raw, surql } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { surrealAdapter } from "../../../src";
import type { SurrealAdapterConfig } from "../../../src";
import { createTestDbConnection, truncateAuthTables } from "../../__helpers__/db";
import { startTestServer } from "../../__helpers__/server";
import type { RunningTestServer } from "../../__helpers__/server";

type JwtPayload = {
  exp?: number;
  id?: string;
  sub?: string;
  email?: string;
  ac?: string;
  ns?: string;
  db?: string;
};

type AuthProbe = {
  authRef: unknown;
  authRaw: unknown;
  tokenRaw: unknown;
  authKey: string;
  authTable: string;
  access: string;
};

type IssuedJwt = {
  signUp: { user: { id: string; email: string } };
  token: string;
  payload: JwtPayload;
};

const testEndpoint = process.env.SURREALDB_TEST_ENDPOINT?.trim() || "ws://localhost:8000/rpc";

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

const decodeJwtPayload = (token: string): JwtPayload => {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("JWT payload segment is missing.");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
};

const firstRows = <T>(raw: T[] | [T[]]) => {
  if (raw.length === 0) return [] as T[];
  if (raw.length === 1 && Array.isArray(raw[0])) {
    return raw[0];
  }
  return raw as T[];
};

describe("Live DB - JWT JWKS Surreal Access", () => {
  let db: Surreal | undefined;
  let closeDb: (() => Promise<true>) | undefined;
  let namespace = "";
  let database = "";
  let accessName = "";
  let jwksPath = "";
  let auth:
    | {
        handler: (request: Request) => Promise<Response>;
        options: BetterAuthOptions;
      }
    | undefined;
  let adapter: DBAdapter | undefined;
  let adapterConfig: SurrealAdapterConfig | undefined;
  let server: RunningTestServer | undefined;

  const requireDb = () => {
    if (!db) throw new Error("Database was not initialized.");
    return db;
  };

  const requireAuth = () => {
    if (!auth) throw new Error("Auth instance was not initialized.");
    return auth;
  };

  const requireAdapter = () => {
    if (!adapter) throw new Error("Adapter was not initialized.");
    return adapter;
  };

  const requireServer = () => {
    if (!server) throw new Error("Test server was not initialized.");
    return server;
  };

  const applyGeneratedSchema = async (file: string) => {
    const schema = await requireAdapter().createSchema?.(
      requireAuth().options as BetterAuthOptions,
      file,
    );
    if (!schema?.code) {
      throw new Error("Adapter did not generate schema code for JWT live tests.");
    }
    await requireDb().query(schema.code);
  };

  const issueJwtForFreshUser = async (): Promise<IssuedJwt> => {
    const liveServer = requireServer();
    const signUpEmail = `jwt-access-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const signUpResponse = await fetch(liveServer.url("/api/auth/sign-up/email"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "JWT Access User",
        email: signUpEmail,
        password: "jwt-access-password-123",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(signUpResponse.status).toBe(200);

    const signUp = (await signUpResponse.json()) as { user: { id: string; email: string } };
    expect(signUp.user.id).toMatch(/^user:/);

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

    return {
      signUp,
      token: tokenBody.token,
      payload: decodeJwtPayload(tokenBody.token),
    };
  };

  beforeAll(async () => {
    accessName = `user_access`;
    jwksPath = `/.well-known/jwks.json`;

    const connection = await createTestDbConnection();
    db = connection.db;
    closeDb = connection.closeDb;
    namespace = connection.namespace;
    database = connection.database;
    adapterConfig = {
      defineAccess: () => surql`
      DEFINE ACCESS OVERWRITE ${raw(escapeIdent(accessName))} ON DATABASE
        TYPE RECORD
        WITH JWT URL ${raw(JSON.stringify(`${requireServer().origin}/api/auth${jwksPath}`))}
        AUTHENTICATE {
          IF $auth {
            RETURN $auth;
          } ELSE {
            THROW "Unable to resolve user from JWT";
          }
        }
        DURATION FOR TOKEN 1h, FOR SESSION 24h;
      `,
    };

    auth = betterAuth({
      baseURL: "http://127.0.0.1:3000",
      secret: "01234567890123456789012345678901",
      emailAndPassword: {
        enabled: true,
        password: {
          hash: async (password: string) => password,
          verify: async ({ hash, password }: { hash: string; password: string }) =>
            hash === password,
        },
      },
      database: surrealAdapter(requireDb(), adapterConfig),
      plugins: [
        jwt({
          jwks: {
            jwksPath,
            keyPairConfig: {
              alg: "RS256",
              modulusLength: 2048,
            },
          },
          jwt: {
            definePayload: (session) => ({
              exp: Math.floor(Date.now() / 1000) + 60 * 15,
              id: session.user.id,
              email: session.user.email,
              ac: accessName,
              ns: namespace,
              db: database,
            }),
            getSubject: (session) => session.user.id,
          },
        }),
      ],
    });

    const authOptions = requireAuth().options as BetterAuthOptions;
    const adapterFactory = authOptions.database as DBAdapterInstance;
    adapter = adapterFactory(authOptions);

    server = await startTestServer(requireAuth());
    await applyGeneratedSchema(".better-auth/schema.surql");
    await truncateAuthTables(requireDb());
  }, 60_000);

  beforeEach(async () => {
    await truncateAuthTables(requireDb());
    await requireDb()
      .query("DELETE jwks;")
      .catch(() => {});
    await applyGeneratedSchema(".better-auth/schema.surql");
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (db) {
      await db.query(`REMOVE ACCESS ${accessName} ON DATABASE;`).catch(() => {});
    }
    if (closeDb) {
      await closeDb();
    }
  });

  it("adds jwks table schema when JWT plugin is configured", async () => {
    const schema = await requireAdapter().createSchema?.(
      requireAuth().options as BetterAuthOptions,
      "jwt-jwks-live.surql",
    );
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
    expect(schema?.code).toContain(`DEFINE ACCESS OVERWRITE ${accessName}`);
    expect(schema?.code).toContain(`WITH JWT URL "${requireServer().origin}/api/auth${jwksPath}"`);
    expect(schema?.code).toContain("AUTHENTICATE {");
    expect(schema?.code).toContain("DURATION FOR TOKEN 1h, FOR SESSION 24h;");
  });

  it("issues a JWT token for an authenticated Better Auth session", async () => {
    const issued = await issueJwtForFreshUser();
    expect(issued.signUp.user.id).toMatch(/^user:/);
    expect(issued.token.split(".")).toHaveLength(3);
  });

  it("embeds Surreal access claims in the Better Auth JWT payload", async () => {
    const issued = await issueJwtForFreshUser();
    const { payload } = issued;
    expect(typeof payload.exp).toBe("number");
    expect(payload.id).toBe(issued.signUp.user.id);
    expect(payload.sub).toBe(issued.signUp.user.id);
    expect(payload.email).toBe(issued.signUp.user.email);
    expect(payload.ac).toBe(accessName);
    expect(payload.ns).toBe(namespace);
    expect(payload.db).toBe(database);
  });

  it("authenticates a SurrealDB client with Better Auth JWT via JWKS URL", async () => {
    const issued = await issueJwtForFreshUser();

    const surrealClient = new Surreal();
    try {
      await surrealClient.connect(testEndpoint);
      await surrealClient.use({ namespace, database });
      await surrealClient.authenticate(issued.token);

      const raw = await surrealClient.query<AuthProbe[] | [AuthProbe[]]>(
        "RETURN { authRef: $auth, authRaw: $auth, tokenRaw: $token, authKey: record::id($auth), authTable: record::tb($auth), access: $access };",
      );
      const result = firstRows(raw)[0];
      expect(result).toBeDefined();
      expect(String(result?.authRef)).toBe(issued.signUp.user.id);
      expect(result?.authKey).toBe(issued.signUp.user.id.split(":")[1]);
      expect(result?.authTable).toBe("user");
      expect(result?.access).toBe(accessName);
    } finally {
      // await surrealClient.close();
    }
  });

});
