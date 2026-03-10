import type { DBAdapter } from "@better-auth/core/db/adapter";
import { type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { JWKSRow } from "../../src/types";
import { getHttpApiBaseUrl, getSurrealHttpHeaders } from "../__helpers__/env";
import { expectOkJson } from "../__helpers__/http";
import { type TestServerHandle, startTestServer } from "../__helpers__/server";
import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";

describe("JWT Plugin - JWKS Schema & Database Persistence", () => {
  let masterDb: Surreal;
  let adapter: DBAdapter;
  let authConfig: BetterAuthOptions;
  let apiBaseUrl: string;
  let headers: Record<string, string>;
  let server: TestServerHandle;

  beforeAll(async () => {
    // Build the adapter with the exact JWT configuration
    const built = await buildAdapter(
      {
        debugLogs: false,
        apiEndpoints: true,
      },
      {
        emailAndPassword: { enabled: true },
        plugins: [
          jwt({
            jwks: {
              keyPairConfig: { alg: "RS256" },
              jwksPath: "/.well-known",
            },
          }),
        ],
      },
    );

    masterDb = built.db;
    adapter = built.adapter;
    authConfig = built.builtConfig;
    apiBaseUrl = getHttpApiBaseUrl();
    headers = getSurrealHttpHeaders();

    // Ensure plugin-dependent tables (including jwks) exist for endpoint tests.
    await ensureSchema(masterDb, adapter, authConfig);
    server = await startTestServer();
  }, 60_000);

  beforeEach(async () => {
    await truncateAuthTables(masterDb);
    await masterDb.query("DELETE jwks").catch(() => {});
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (masterDb) {
      await masterDb.close();
    }
  });

  it("dynamically generates the 'jwks' schema correctly via createSchema", async () => {
    // 1. Run createSchema using the schema definitions that Better Auth generated
    const result = await adapter.createSchema!(authConfig, "test.surql");

    expect(result).toBeDefined();
    const sql = result.code;

    // 2. Verify the jwks table was added
    expect(sql).toContain("DEFINE TABLE jwks SCHEMAFULL;");

    // 3. Verify the core JWKS fields are present as standard strings
    expect(sql).toContain("DEFINE FIELD publicKey ON jwks TYPE string;");
    expect(sql).toContain("DEFINE FIELD privateKey ON jwks TYPE string;");
    expect(sql).toContain("DEFINE FIELD createdAt ON jwks TYPE datetime;");
    expect(sql).toContain('DEFINE API OVERWRITE "/jwks"');
  });

  it("should return 200 and a valid JWKS response for the jwks endpoint", async () => {
    const response = await fetch(`${server.baseUrl}/api/auth/.well-known`, {
      signal: AbortSignal.timeout(5_000),
    });

    const jwks = (await expectOkJson(response, "Better Auth JWKS endpoint")) as { keys: any[] };
    expect(jwks.keys).toBeDefined();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("persists the generated JWKS key pair to the SurrealDB database", async () => {
    const response = await fetch(`${server.baseUrl}/api/auth/.well-known`, {
      signal: AbortSignal.timeout(5_000),
    });

    const jwks = (await expectOkJson(response, "Better Auth JWKS persistence trigger")) as {
      keys: any[];
    };
    expect(jwks.keys).toBeDefined();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);

    // 4. Query the database directly to verify it was saved!
    const jwksRecords = await adapter.findMany<JWKSRow>({
      model: "jwks",
    });

    // 5. Assertions
    expect(jwksRecords).toHaveLength(1);

    const activeKey = jwksRecords[0];
    expect(activeKey).toBeDefined();
    expect(activeKey?.publicKey).toBeDefined();
    expect(activeKey?.privateKey).toBeDefined();
    expect(activeKey?.createdAt).toBeDefined();

    // Check that it's a valid string-based key
    expect(typeof activeKey?.publicKey).toBe("string");
    expect(typeof activeKey?.privateKey).toBe("string");
    expect((activeKey?.publicKey as string).length).toBeGreaterThan(100);
  });

  it("serves the generated jwks table through the live SurrealDB HTTP API", async () => {
    const response = await fetch(`${server.baseUrl}/api/auth/.well-known`, {
      signal: AbortSignal.timeout(5_000),
    });

    await expectOkJson(response, "Better Auth JWKS generation before SurrealDB API read");

    const apiResponse = await fetch(`${apiBaseUrl}/jwks`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    const body = (await expectOkJson(apiResponse, "SurrealDB /jwks endpoint")) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(typeof body[0]?.publicKey).toBe("string");
  });
});
