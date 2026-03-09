import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";
import type { JWKSRow } from "../../src/types";

describe("JWT Plugin - JWKS Schema & Database Persistence", () => {
  let masterDb: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  let authConfig: BetterAuthOptions;

  beforeAll(async () => {
    // Build the adapter with the exact JWT configuration
    const built = await buildAdapter(
      { debugLogs: false },
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
    auth = built.auth;

    adapter = built.adapter;
    authConfig = built.builtConfig;

    // Ensure plugin-dependent tables (including jwks) exist for endpoint tests.
    await ensureSchema(masterDb, adapter, authConfig);
  }, 60_000);

  beforeEach(async () => {
    await truncateAuthTables(masterDb);
    await masterDb.query("DELETE jwks").catch(() => {});
  });

  afterAll(async () => {
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
  });

  it("should return 200 and a valid JWKS response for the jwks endpoint", async () => {
    const response = await auth.handler(
      new Request("http://localhost/api/auth/.well-known", { method: "GET" }),
    );
    expect(response?.status).toBe(200);
    const jwks = (await response?.json()) as { keys: any[] };
    expect(jwks.keys).toBeDefined();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("persists the generated JWKS key pair to the SurrealDB database", async () => {
    // Hit the JWKS endpoint via the handler to trigger key generation/persistence.
    const response = await auth.handler(
      new Request("http://localhost/api/auth/.well-known", { method: "GET" }),
    );

    // Assertions on the HTTP response
    expect(response?.status).toBe(200);
    const jwks = (await response?.json()) as { keys: any[] };
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
});
