import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestServerHandle } from "../../__helpers__/server";

import { executeSurqlSchema } from "../../../src/schema";
import { getScopedDbName, getTestDbEnv } from "../../__helpers__/env";
import { expectOkJson, fetchWithTimeout, getCookieHeader } from "../../__helpers__/http";
import { startTestServer } from "../../__helpers__/server";
import { setupIntegrationAdapter } from "../../test-utils";

const decodeJwtPayload = (token: string) => {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("JWT payload segment is missing");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
};

describe("Plugin - JWT SurrealDB Access", () => {
  let masterDb: Surreal;
  let adapter: DBAdapter;
  let authConfig: BetterAuthOptions;
  let server: TestServerHandle;
  let accessName: string;
  let namespace: string;
  let database: string;
  let jwksPath: string;
  let resetDb: () => Promise<void>;
  let closeDb: () => Promise<true>;

  beforeAll(async () => {
    accessName = `better_auth_user_${Date.now()}`;
    const env = getTestDbEnv();
    namespace = getScopedDbName(env.namespace);
    database = getScopedDbName(env.database);

    jwksPath = `/.well-known.json`;

    const built = await setupIntegrationAdapter(
      {
        debugLogs: false,
        apiEndpoints: true,
      },
      {
        emailAndPassword: { enabled: true },
        plugins: [
          jwt({
            jwks: {
              jwksPath,
            },
            jwt: {
              definePayload: (session) => ({
                exp: Math.floor(Date.now() / 1000) + 60 * 15,
                id: `user:${session.user.id}`,
                email: session.user.email,
                ac: accessName,
                ns: namespace,
                db: database,
              }),
              getSubject: (session) => `user:${session.user.id}`,
            },
          }),
        ],
      },
    );

    masterDb = built.db;
    adapter = built.adapter;
    authConfig = built.builtConfig;

    resetDb = built.reset;
    closeDb = built.close;

    server = await startTestServer({
      port: 3003,
      env: {
        SURREALDB_ACCESS: accessName,
        JWT_JWKS_PATH: jwksPath,
      },
    });

    const jwksUrl = `${server.baseUrl}/api/auth${jwksPath}`;

    await executeSurqlSchema(
      masterDb,
      `
DEFINE ACCESS OVERWRITE ${accessName}
  ON DATABASE
  TYPE RECORD
  WITH JWT URL "${jwksUrl}";
`,
    );
  }, 60_000);

  beforeEach(async () => {
    await resetDb();
    await masterDb.query(`REMOVE ACCESS ${accessName} ON DATABASE`).catch(() => {});

    const jwksUrl = `${server.baseUrl}/api/auth${jwksPath}`;
    await executeSurqlSchema(
      masterDb,
      `
DEFINE ACCESS OVERWRITE ${accessName}
  ON DATABASE
  TYPE RECORD
  WITH JWT URL "${jwksUrl}";
`,
    );
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (masterDb) {
      await closeDb();
    }
  });

  it("configures a Better Auth JWT payload with the user id needed for SurrealDB access", async () => {
    const result = await adapter.createSchema!(authConfig, "test.surql");

    expect(result).toBeDefined();
    expect(result.code).toContain("DEFINE TABLE jwks SCHEMAFULL;");
  });

  it("authenticates a SurrealDB client with a Better Auth JWT via JWKS URL", async () => {
    const signUpResponse = await fetchWithTimeout(`${server.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseUrl,
      },
      body: JSON.stringify({
        name: "JWT Access User",
        email: `jwt-access-${Date.now()}@example.com`,
        password: "jwt-access-password-123",
      }),
    });

    const signUp = await expectOkJson<{
      user: { id: string; email: string };
    }>(signUpResponse, "Better Auth sign-up for JWT access");

    const cookieHeader = getCookieHeader(signUpResponse);
    expect(cookieHeader).not.toBe("");

    const tokenResponse = await fetchWithTimeout(`${server.baseUrl}/api/auth/token`, {
      headers: {
        cookie: cookieHeader,
        origin: server.baseUrl,
      },
    });

    const { token } = await expectOkJson<{
      token: string;
    }>(tokenResponse, "Better Auth token endpoint");
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);

    const payload = decodeJwtPayload(token);
    expect(payload.exp).toEqual(expect.any(Number));
    expect(payload.ns).toBe(namespace);
    expect(payload.db).toBe(database);
    expect(payload.ac).toBe(accessName);
    expect(payload.id).toBe(`user:${signUp.user.id}`);
    expect(payload.sub).toBe(`user:${signUp.user.id}`);
    expect(payload.email).toBe(signUp.user.email);

    const env = getTestDbEnv();
    const surrealClient = new Surreal();
    try {
      await surrealClient.connect(env.endpoint);
      await surrealClient.use({
        namespace,
        database,
      });
      await surrealClient.authenticate(token);

      const [result] = (await surrealClient.query(
        "RETURN { authRef: $auth, authKey: record::id($auth), authTable: record::tb($auth), access: $access };",
      )) as [
        {
          authRef: unknown;
          authKey: string;
          authTable: string;
          access: string;
        },
      ];

      expect(String(result.authRef)).toBe(`user:${signUp.user.id}`);
      expect(result.authKey).toBe(signUp.user.id);
      expect(result.authTable).toBe("user");
      expect(result.access).toBe(accessName);
    } finally {
      await surrealClient.close();
    }
  });
});
