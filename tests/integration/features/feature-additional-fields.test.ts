import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../../test-utils";

describe("Feature - Additional Fields Schema", () => {
  let db: Surreal;
  let auth: Awaited<ReturnType<typeof buildAdapter>>["auth"];
  let adapter: DBAdapter;
  let builtConfig: Awaited<ReturnType<typeof buildAdapter>>["builtConfig"];

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        emailAndPassword: {
          enabled: true,
        },
        user: {
          additionalFields: {
            birthday: {
              type: "date",
              required: false,
              input: true,
            },
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
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it("adds configured additionalFields to generated schema and persists values", async () => {
    const schema = await adapter.createSchema!(builtConfig, "additional-fields.surql");

    expect(schema.code).toMatch(/DEFINE FIELD birthday ON user TYPE option<datetime>;/);
    const birthday = new Date("1990-06-15T00:00:00.000Z");

    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Additional Field User",
        email: `additional-field-${Date.now()}@example.com`,
        password: "Password123!",
        birthday: birthday.toISOString(),
      } as {
        name: string;
        email: string;
        password: string;
        birthday: string;
      },
    });

    const dbUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signUp.user.id }],
    });

    expect(dbUser).not.toBeNull();
    expect(dbUser?.birthday).toBeInstanceOf(Date);
    expect((dbUser?.birthday as Date).toISOString()).toBe(birthday.toISOString());
  });
});
