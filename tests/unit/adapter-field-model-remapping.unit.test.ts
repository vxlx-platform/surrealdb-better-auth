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
    emailAndPassword: {
      enabled: true,
    },
    user: {
      modelName: "app_user",
      fields: {
        name: "display_name",
        email: "email_address",
        emailVerified: "email_verified",
        image: "avatar_url",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "app_session",
      fields: {
        expiresAt: "expires_at",
        token: "session_token",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "owner_id",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "app_account",
      fields: {
        accountId: "provider_account_id",
        providerId: "provider",
        userId: "owner_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_expires_at",
        refreshTokenExpiresAt: "refresh_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "app_verification",
      fields: {
        identifier: "verification_identifier",
        value: "verification_value",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    database: surrealAdapter(client as never),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  const adapter = factory(options);
  return { adapter, options, client };
};

describe("Adapter Core - Field/Model Remapping (Mocked Schema)", () => {
  it("emits remapped table and field names in generated schema", async () => {
    const { adapter, options } = buildAdapter();
    const schema = await adapter.createSchema?.(options, "field-model-remapping.surql");

    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE app_user SCHEMAFULL;");
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE display_name ON TABLE app_user TYPE string;",
    );
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE email_address ON TABLE app_user TYPE string;",
    );
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE app_session SCHEMAFULL;");
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE owner_id ON TABLE app_session TYPE record<app_user>;",
    );
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE app_account SCHEMAFULL;");
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE provider_account_id ON TABLE app_account TYPE string;",
    );
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE app_verification SCHEMAFULL;");
    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE verification_identifier ON TABLE app_verification TYPE string;",
    );
  });

  it("uses remapped table and field names in runtime queries", async () => {
    const { adapter, client } = buildAdapter();
    client.query.mockResolvedValue([[]]);

    await adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "remap@example.com" }],
      sortBy: { field: "createdAt", direction: "desc" },
      select: ["id", "email", "createdAt"],
      limit: 10,
      offset: 2,
    });

    expect(client.query).toHaveBeenCalled();
    const [query, bindings] = client.query.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(query).toContain("FROM app_user");
    expect(query).toContain("email_address");
    expect(query).toContain("created_at");
    expect(query).toContain("ORDER BY created_at DESC");
    expect(query).toContain("LIMIT $limit");
    expect(query).toContain("START $offset");
    expect(bindings.limit).toBe(10);
    expect(bindings.offset).toBe(2);
  });
});
