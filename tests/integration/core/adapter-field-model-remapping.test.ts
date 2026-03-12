import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { type Surreal, Table } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { truncateTables } from "../../__helpers__/db";
import { buildAdapter, ensureSchema } from "../../test-utils";

const REMAPPED_AUTH_TABLES = [
  "app_session",
  "app_account",
  "app_verification",
  "app_user",
] as const;

describe("Adapter Core - Field/Model Remapping", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  let builtConfig: BetterAuthOptions;

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
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
      },
    );

    db = built.db;
    auth = built.auth;
    adapter = built.adapter;
    builtConfig = built.builtConfig;

    await ensureSchema(db, adapter, builtConfig);
  }, 60_000);

  beforeEach(async () => {
    await truncateTables(db, REMAPPED_AUTH_TABLES);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it("generates remapped schema and supports logical CRUD through mapped tables/fields", async () => {
    const schema = await adapter.createSchema!(builtConfig, "field-model-remapping.surql");

    expect(schema.code).toContain("DEFINE TABLE app_user SCHEMAFULL;");
    expect(schema.code).toContain("DEFINE FIELD display_name ON app_user TYPE string;");
    expect(schema.code).toContain("DEFINE FIELD email_address ON app_user TYPE string;");
    expect(schema.code).toContain("DEFINE TABLE app_session SCHEMAFULL;");
    expect(schema.code).toContain("DEFINE FIELD owner_id ON app_session TYPE record<app_user>;");
    expect(schema.code).toContain("DEFINE TABLE app_account SCHEMAFULL;");
    expect(schema.code).toContain("DEFINE FIELD provider_account_id ON app_account TYPE string;");

    const email = `remap-${Date.now()}@example.com`;
    const password = "Password123!";
    const name = "Mapped User";

    const signUp = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password,
      },
    });
    expect(signUp.user.id).toBeDefined();

    const signIn = await auth.api.signInEmail({
      body: {
        email,
        password,
      },
    });
    expect(signIn.user.id).toBe(signUp.user.id);

    const logicalUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "eq", value: email }],
    });
    expect(logicalUser).not.toBeNull();
    expect(logicalUser?.name).toBe(name);
    expect(logicalUser?.email).toBe(email);

    const rawUsers = (await db.select(new Table("app_user"))) as Array<Record<string, unknown>>;
    const rawUser = rawUsers.find((row) => row.email_address === email);
    expect(rawUser).toBeDefined();
    expect(rawUser?.display_name).toBe(name);
    expect(rawUser?.name).toBeUndefined();

    const rawSessions = (await db.select(new Table("app_session"))) as Array<Record<string, unknown>>;
    const ownerRecordId = `app_user:${signUp.user.id}`;
    const rawSession = rawSessions.find((row) => String(row.owner_id) === ownerRecordId);
    expect(rawSession).toBeDefined();
    expect(typeof rawSession?.session_token).toBe("string");

    const rawAccounts = (await db.select(new Table("app_account"))) as Array<Record<string, unknown>>;
    const rawAccount = rawAccounts.find(
      (row) => row.provider === "credential" && String(row.owner_id) === ownerRecordId,
    );
    expect(rawAccount).toBeDefined();
    expect(typeof rawAccount?.provider_account_id).toBe("string");
  });
});
