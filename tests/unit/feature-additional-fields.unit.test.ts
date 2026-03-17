import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { BoundQuery, DateTime, RecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  beginTransaction: ReturnType<typeof vi.fn>;
  isFeatureSupported: ReturnType<typeof vi.fn>;
};

const createMockCreateQuery = () => {
  let data: unknown;
  return {
    content(value: unknown) {
      data = value;
      return this;
    },
    output() {
      return this;
    },
    compile() {
      return new BoundQuery("CREATE ONLY user CONTENT $data RETURN AFTER;", { data });
    },
  };
};

const createMockClient = (): MockClient => ({
  query: vi.fn().mockResolvedValue([
    [
      {
        id: new RecordId("user", "birthday-user"),
        name: "Birthday User",
        email: "birthday@example.com",
        emailVerified: false,
        birthday: new DateTime("1990-06-15T00:00:00.000Z"),
      },
    ],
  ]),
  create: vi.fn(() => createMockCreateQuery()),
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
        birthday: {
          type: "date",
          required: false,
          input: true,
        },
      },
    },
    database: surrealAdapter(client as never),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  const adapter = factory(options);

  return { client, adapter, options };
};

describe("Feature - Additional Fields (Mocked)", () => {
  it("adds user additional date fields to generated schema", async () => {
    const { adapter, options } = buildAdapter();
    const schema = await adapter.createSchema?.(options, "additional-fields.surql");

    expect(schema?.code).toContain(
      "DEFINE FIELD OVERWRITE birthday ON TABLE user TYPE option<datetime>;",
    );
  });

  it("transforms additional date fields on write and read", async () => {
    const { client, adapter } = buildAdapter();
    const birthday = new Date("1990-06-15T00:00:00.000Z");

    const created = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "Birthday User",
        email: "birthday@example.com",
        emailVerified: false,
        birthday,
      },
    });

    const [, bindings] = client.query.mock.calls[0] as [string, Record<string, unknown>];
    const payload = bindings.data as Record<string, unknown>;
    expect(payload.birthday).toBeInstanceOf(DateTime);

    expect(created.birthday).toBeInstanceOf(Date);
    expect((created.birthday as Date).toISOString()).toBe(birthday.toISOString());
  });
});
