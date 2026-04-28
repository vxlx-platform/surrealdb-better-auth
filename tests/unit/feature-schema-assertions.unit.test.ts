import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../src";

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

const buildAdapter = () => {
  const client = createMockClient();
  const auth = betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "01234567890123456789012345678901",
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        username: {
          type: "string",
          required: true,
        },
        nickname: {
          type: "string",
          required: false,
        },
        age: {
          type: "number",
          required: false,
          bigint: true,
        },
      },
    },
    database: surrealAdapter(client as never, {
      schemaAssertions: {
        fields: {
          "user.email": { email: true },
          "user.username": {
            minLength: 3,
            maxLength: 32,
            pattern: "^[a-z0-9_]+$",
          },
          "user.nickname": {
            minLength: 2,
            maxLength: 20,
            pattern: "^[a-z]+$",
          },
          "user.age": {
            min: 13,
            max: 120,
          },
        },
      },
    }),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  const adapter = factory(options);

  return { adapter, options };
};

describe("Feature - Schema Assertions (Mocked)", () => {
  it("emits ASSERT clauses for supported simple field rules", async () => {
    const { adapter, options } = buildAdapter();
    const schema = await adapter.createSchema?.(
      options,
      "schema-assertions.surql",
    );

    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE email ON TABLE user TYPE string ASSERT string::is_email($value);",
    );
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE username ON TABLE user TYPE string ASSERT string::len($value) >= 3 AND string::len($value) <= 32 AND string::matches($value, '^[a-z0-9_]+$');",
    );
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE nickname ON TABLE user TYPE option<string> ASSERT $value = NONE OR (string::len($value) >= 2 AND string::len($value) <= 20 AND string::matches($value, '^[a-z]+$'));",
    );
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE age ON TABLE user TYPE option<int> ASSERT $value = NONE OR ($value >= 13 AND $value <= 120);",
    );
  });
});
