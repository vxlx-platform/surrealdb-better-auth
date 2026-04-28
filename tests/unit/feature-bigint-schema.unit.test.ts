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
    rateLimit: {
      storage: "database",
    },
    database: surrealAdapter(client as never),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  const adapter = factory(options);

  return { adapter, options };
};

describe("Feature - Bigint Schema (Mocked)", () => {
  it("maps Better Auth bigint number fields to Surreal int schema fields", async () => {
    const { adapter, options } = buildAdapter();
    const schema = await adapter.createSchema?.(options, "bigint-schema.surql");

    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE lastRequest ON TABLE rateLimit TYPE int;"
    );
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE count ON TABLE rateLimit TYPE number;"
    );
  });
});
