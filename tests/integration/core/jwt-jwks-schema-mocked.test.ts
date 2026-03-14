import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { BoundQuery } from "surrealdb";
import { surql } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  beginTransaction: ReturnType<typeof vi.fn>;
  isFeatureSupported: ReturnType<typeof vi.fn>;
};

const createMockClient = (): MockClient => ({
  query: vi.fn(),
  beginTransaction: vi.fn(),
  isFeatureSupported: vi.fn(() => false),
});

const baseURL = "http://127.0.0.1:3000";
const secret = "01234567890123456789012345678901";

type TestAuthInput = {
  defineAccess?: () => BoundQuery<unknown[]>;
  includeJwtPlugin?: boolean;
};

const createTestAuth = (client: MockClient, input: TestAuthInput = {}) => {
  const adapterConfig =
    input.defineAccess === undefined ? undefined : { defineAccess: input.defineAccess };

  return betterAuth({
    baseURL,
    secret,
    database: surrealAdapter(client as never, adapterConfig),
    plugins:
      input.includeJwtPlugin === false
        ? []
        : [
            jwt({
              jwks: {
                jwksPath: "/.well-known/jwks.json",
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
};

const generateSchema = async (input: TestAuthInput, file: string) => {
  const client = createMockClient();
  const auth = createTestAuth(client, input);
  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  const adapter = factory(options);
  return adapter.createSchema?.(options, file);
};

describe("JWT JWKS Schema - Mocked", () => {
  it("emits custom DEFINE ACCESS in schema when defineAccess callback is configured", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE better_auth_user ON DATABASE
  TYPE RECORD
  WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known/jwks.json"
  AUTHENTICATE {
    IF $auth.id { RETURN $auth.id }
    ELSE IF $token.email { RETURN (SELECT VALUE id FROM user WHERE email = $token.email LIMIT 1)[0] }
  }
  DURATION FOR TOKEN 1h, FOR SESSION 24h
`,
      },
      "jwt-jwks.surql",
    );

    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE better_auth_user");
    expect(schema?.code).toContain(
      'WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known/jwks.json"',
    );
    expect(schema?.code).toContain("AUTHENTICATE {");
    expect(schema?.code).toContain("DURATION FOR TOKEN 1h, FOR SESSION 24h;");
  });

  it("emits DEFINE ACCESS when defineAccess returns a BoundQuery", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE better_auth_user ON DATABASE
  TYPE RECORD
  WITH JWT URL "https://example.com/.well-known/jwks.json";
`,
      },
      "jwt-jwks-string.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE better_auth_user");
    expect(schema?.code).toContain('WITH JWT URL "https://example.com/.well-known/jwks.json";');
  });

  it("appends a trailing semicolon when defineAccess omits one", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE service_api ON DATABASE
  TYPE API KEY
`,
      },
      "jwt-access-semicolon-added.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE service_api ON DATABASE");
    expect(schema?.code).toContain("TYPE API KEY;");
  });

  it("does not duplicate semicolons when defineAccess already includes one", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE service_api ON DATABASE
  TYPE API KEY;
`,
      },
      "jwt-access-semicolon-preserved.surql",
    );

    expect(schema?.code).toContain("TYPE API KEY;");
    expect(schema?.code).not.toContain("TYPE API KEY;;");
  });

  it("supports TYPE JWT URL access definitions", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE oauth ON DATABASE
  TYPE JWT
  URL "https://issuer.example.com/.well-known/jwks.json"
  DURATION FOR TOKEN 1h, FOR SESSION 24h;
`,
      },
      "jwt-access-type-jwt-url.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE oauth ON DATABASE");
    expect(schema?.code).toContain("TYPE JWT");
    expect(schema?.code).toContain('URL "https://issuer.example.com/.well-known/jwks.json"');
    expect(schema?.code).toContain("DURATION FOR TOKEN 1h, FOR SESSION 24h;");
  });

  it("supports TYPE JWT algorithm/key access definitions", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE api_auth ON NAMESPACE
  TYPE JWT
  ALGORITHM RS256
  KEY "PUBLIC_KEY_DATA"
  WITH ISSUER KEY "PRIVATE_KEY_DATA"
  DURATION FOR TOKEN 1h;
`,
      },
      "jwt-access-type-jwt-key.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE api_auth ON NAMESPACE");
    expect(schema?.code).toContain("ALGORITHM RS256");
    expect(schema?.code).toContain('KEY "PUBLIC_KEY_DATA"');
    expect(schema?.code).toContain('WITH ISSUER KEY "PRIVATE_KEY_DATA"');
    expect(schema?.code).toContain("DURATION FOR TOKEN 1h;");
  });

  it("supports TYPE RECORD WITH JWT ALGORITHM/KEY definitions", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE external_auth ON DATABASE
  TYPE RECORD
  WITH JWT ALGORITHM RS256 KEY "PUBLIC_KEY_DATA"
  AUTHENTICATE {
    IF $auth.id { RETURN $auth.id }
    ELSE IF $token.sub { RETURN $token.sub }
  }
  DURATION FOR TOKEN 1h, FOR SESSION 24h;
`,
      },
      "jwt-access-record-with-jwt-key.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE external_auth ON DATABASE");
    expect(schema?.code).toContain("TYPE RECORD");
    expect(schema?.code).toContain('WITH JWT ALGORITHM RS256 KEY "PUBLIC_KEY_DATA"');
    expect(schema?.code).toContain("AUTHENTICATE {");
  });

  it("does not emit DEFINE ACCESS when defineAccess is omitted", async () => {
    const schema = await generateSchema({}, "jwt-jwks-no-access.surql");

    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
    expect(schema?.code).not.toContain("DEFINE ACCESS");
  });

  it("does not emit jwks table when JWT plugin is not configured", async () => {
    const schema = await generateSchema(
      {
        includeJwtPlugin: false,
      },
      "jwt-jwks-plugin-disabled.surql",
    );

    expect(schema?.code).not.toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
  });

  it("emits DEFINE ACCESS even when JWT plugin is not configured", async () => {
    const schema = await generateSchema(
      {
        includeJwtPlugin: false,
        defineAccess: () => surql`
DEFINE ACCESS OVERWRITE manual_access ON DATABASE
  TYPE API KEY;
`,
      },
      "jwt-jwks-manual-access-no-plugin.surql",
    );

    expect(schema?.code).toContain("DEFINE ACCESS OVERWRITE manual_access ON DATABASE");
    expect(schema?.code).toContain("TYPE API KEY;");
  });

  it("skips DEFINE ACCESS when defineAccess callback returns empty content", async () => {
    const schema = await generateSchema(
      {
        defineAccess: () => surql`   `,
      },
      "jwt-jwks-empty-access.surql",
    );

    expect(schema?.code).not.toContain("DEFINE ACCESS");
  });

  it("rejects defineAccess queries that contain bindings", async () => {
    const schemaPromise = generateSchema(
      {
        defineAccess: () => surql`DEFINE ACCESS OVERWRITE ${"bound_name"} ON DATABASE TYPE API KEY;`,
      },
      "jwt-jwks-bound-query.surql",
    );

    await expect(schemaPromise).rejects.toThrow(
      /defineAccess must not include bindings in schema generation/,
    );
  });
});
