import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { RecordId, type Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables, createTestDb } from "./test-utils";

const _getAuthType = () =>
  betterAuth({
    database: {} as any,
    emailAndPassword: { enabled: true },
    plugins: [jwt()],
  });

type AuthWithJwt = ReturnType<typeof _getAuthType>;

describe("JWT Plugin & SurrealDB JWKS RECORD Authentication", () => {
  let masterDb: Surreal;
  let auth: AuthWithJwt;
  let adapter: DBAdapter;
  let server: Server;

  // We'll dynamically fetch these from the test DB to ensure isolation,
  // but they represent your "main" ns/db from your config.
  let currentNs = "main";
  let currentDb = "main";

  const TEST_SERVER_PORT = 3050;
  // Use host.docker.internal if SurrealDB is running in a Docker container
  const HOST = "127.0.0.1";

  beforeAll(async () => {
    const { db } = await createTestDb();
    masterDb = db;

    // Dynamically retrieve the namespace and database strings
    const [nsInfo] = await masterDb.query<[string]>("RETURN $session.ns");
    const [dbInfo] = await masterDb.query<[string]>("RETURN $session.db");
    if (nsInfo) currentNs = nsInfo;
    if (dbInfo) currentDb = dbInfo;

    await truncateAuthTables(masterDb);

    const built = await buildAdapter(
      { debugLogs: false },
      {
        emailAndPassword: { enabled: true },
        plugins: [
          jwt({
            jwt: {
              // Your exact definePayload implementation
              definePayload: ({ user }) => {
                return {
                  ns: currentNs, // Injected dynamically for test DB matching
                  db: currentDb,
                  ac: "user_access",
                  id: new RecordId("user", user.id),
                  email: user.email,
                  emailVerified: user.emailVerified,
                };
              },
            },
            jwks: {
              // Your custom JWKS path
              jwksPath: "/.well-known",
            },
          }),
        ],
      },
    );
    auth = built.auth as unknown as AuthWithJwt;
    adapter = built.adapter;

    await ensureSchema(masterDb, adapter, built.builtConfig);

    // Start a local HTTP server to expose the Better Auth JWKS endpoint to SurrealDB
    server = createServer(toNodeHandler(auth.handler));
    await new Promise<void>((resolve) => {
      server.listen(TEST_SERVER_PORT, "0.0.0.0", () => resolve());
    });

    // Define the RECORD Access mapping the JWT to the user table
    // URL strictly matches your jwksPath: "/.well-known"
    await masterDb.query(`
      DEFINE ACCESS user_access 
        ON DATABASE 
        TYPE RECORD 
        WITH JWT
        URL "http://${HOST}:${TEST_SERVER_PORT}/.well-known"

        // The authenticate block logic for TYPE RECORD.
        // Because your payload includes 'id: new RecordId("user", user.id)', 
        // the JWT will serialize this as a string (e.g., "user:123"). 
        // We can cast it directly back to a record pointer!
        AUTHENTICATE {
          IF $auth.id {
              RETURN $auth.id;
          } ELSE IF $token.email {
              RETURN SELECT * FROM user WHERE email = $token.email;
          };
        };
    `);
  });

  afterAll(async () => {
    if (masterDb) {
      await masterDb.query("REMOVE ACCESS user_access ON DATABASE").catch(() => {});
      await masterDb.close();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("authenticates as a specific database record using custom JWKS path and payload", async () => {
    // 1. Sign up the user (this creates the actual row in the 'user' table)
    const signUpResult = await auth.api.signUpEmail({
      body: {
        name: "Record Access User",
        email: "record-access@example.com",
        password: "securePassword123",
      },
    });

    expect(signUpResult.token).toBeDefined();

    // 2. Fetch the JWT mapped with your custom SurrealDB claims
    const tokenResponse = await fetch(`http://${HOST}:${TEST_SERVER_PORT}/api/auth/token`, {
      headers: { Authorization: `Bearer ${signUpResult.token}` },
    });

    expect(tokenResponse.ok).toBe(true);
    const { token: jwtToken } = await tokenResponse.json();
    expect(jwtToken).toBeDefined();

    // 3. Create a fresh, completely unauthenticated database connection
    const { db: clientDb } = await createTestDb();
    await clientDb.invalidate(); // Drop all root/admin privileges

    // 4. Authenticate using the JWT
    // SurrealDB hits "/.well-known", validates the signature,
    // extracts your custom "id" claim, runs type::thing($token.id), and scopes $auth!
    await expect(clientDb.authenticate(jwtToken)).resolves.not.toThrow();

    // 5. Verify that TYPE RECORD authentication successfully populated $auth
    const [authContext] = await clientDb.query<[any]>("RETURN $auth");

    expect(authContext).toBeDefined();
    // Verify the database mapped the token to the actual table row
    expect(authContext.email).toBe("record-access@example.com");

    // 6. Verify the token payload matches your custom definePayload structure
    const [tokenContext] = await clientDb.query<[any]>("RETURN $token");
    expect(tokenContext.ns).toBe(currentNs);
    expect(tokenContext.db).toBe(currentDb);
    expect(tokenContext.ac).toBe("user_access");
    // Verify that the RecordId was safely serialized to the string representation
    expect(tokenContext.id).toBe(`user:${signUpResult.user.id}`);

    await clientDb.close();
  });
});
