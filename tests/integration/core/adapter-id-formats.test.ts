import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { surrealAdapter } from "../../../src";
import { createTestDbConnection, truncateAuthTables } from "../../__helpers__/db";
import { buildUserSeed } from "../../__helpers__/fixtures";

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const RANDOM_ID_REGEX = /^[a-zA-Z0-9]+$/;

type RecordIdFormat = "native" | "ulid" | "uuidv7";
type RecordIdFormatResolver = RecordIdFormat | ((input: { model: string }) => RecordIdFormat);

type BuiltFormatCase = {
  auth: ReturnType<typeof betterAuth>;
  adapter: DBAdapter;
};

const parseRecordIdPart = (recordId: string) => {
  const separator = recordId.indexOf(":");
  if (separator < 1 || separator === recordId.length - 1) {
    throw new Error(`Invalid record id "${recordId}".`);
  }
  let value = recordId.slice(separator + 1).trim();

  if (value.startsWith("⟨") && value.endsWith("⟩")) {
    value = value.slice(1, -1);
  }

  const quotedUuidMatch = value.match(/^u(['"])(.+)\1$/);
  if (quotedUuidMatch?.[2]) {
    return quotedUuidMatch[2];
  }

  return value;
};

describe("Live DB - Adapter Record ID Formats", () => {
  let closeDb: (() => Promise<true>) | undefined;
  let db: Awaited<ReturnType<typeof createTestDbConnection>>["db"] | undefined;

  const requireDb = () => {
    if (!db) throw new Error("Database was not initialized.");
    return db;
  };

  const setupFormatCase = async (
    recordIdFormat: RecordIdFormatResolver,
  ): Promise<BuiltFormatCase> => {
    const auth = betterAuth({
      baseURL: "http://127.0.0.1:3000",
      secret: "01234567890123456789012345678901",
      emailAndPassword: {
        enabled: true,
        password: {
          hash: async (password) => password,
          verify: async ({ hash, password }) => hash === password,
        },
      },
      database: surrealAdapter(requireDb(), { recordIdFormat }),
      advanced: {
        database: {
          generateId: false,
        },
      },
    }) as ReturnType<typeof betterAuth>;

    const options = auth.options as BetterAuthOptions;
    const factory = options.database as DBAdapterInstance;
    const adapter = factory(options);

    const schema = await adapter.createSchema?.(options, ".better-auth/schema.surql");
    if (!schema?.code) {
      throw new Error("Adapter did not generate schema code for id format tests.");
    }
    await requireDb().query(schema.code);
    await truncateAuthTables(requireDb());

    return { auth, adapter };
  };

  beforeAll(async () => {
    const connection = await createTestDbConnection();
    db = connection.db;
    closeDb = connection.closeDb;
  }, 60_000);

  afterEach(async () => {
    if (db) {
      await truncateAuthTables(db);
    }
  });

  afterAll(async () => {
    if (closeDb) {
      await closeDb();
    }
  });

  it("creates user with ULID id format", async () => {
    const built = await setupFormatCase("ulid");
    const result = await built.auth.api.signUpEmail({
      body: {
        name: "ULID User",
        email: "ulid.user@example.com",
        password: "password1234",
      },
    });

    expect(ULID_REGEX.test(parseRecordIdPart(result.user.id))).toBe(true);
  });

  it("creates user and session record ids with UUID format", async () => {
    const built = await setupFormatCase("uuidv7");
    const result = await built.auth.api.signUpEmail({
      body: {
        name: "UUID User",
        email: "uuid.user@example.com",
        password: "password1234",
      },
    });

    expect(UUID_V7_REGEX.test(parseRecordIdPart(result.user.id))).toBe(true);

    const sessions = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(sessions).toHaveLength(1);
    expect(UUID_V7_REGEX.test(parseRecordIdPart(String(sessions[0]?.id)))).toBe(true);
  });

  it("creates user and session record ids with ULID format", async () => {
    const built = await setupFormatCase("ulid");
    const result = await built.auth.api.signUpEmail({
      body: {
        name: "ULID User",
        email: "ulid.user@example.com",
        password: "password1234",
      },
    });

    expect(ULID_REGEX.test(parseRecordIdPart(result.user.id))).toBe(true);

    const sessions = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(sessions).toHaveLength(1);
    expect(ULID_REGEX.test(parseRecordIdPart(String(sessions[0]?.id)))).toBe(true);
  });

  it("creates random native record ids by default", async () => {
    const built = await setupFormatCase("native");
    const result = await built.auth.api.signUpEmail({
      body: {
        name: "Native User",
        email: "native.user@example.com",
        password: "password1234",
      },
    });

    const id = parseRecordIdPart(result.user.id);
    expect(RANDOM_ID_REGEX.test(id)).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(20);
  });

  it("supports table-specific recordIdFormat resolver", async () => {
    const built = await setupFormatCase(({ model }) => {
      if (model === "user") return "uuidv7";
      if (model === "account") return "ulid";
      return "native";
    });

    const result = await built.auth.api.signUpEmail({
      body: {
        name: "Mixed User",
        email: "mixed.user@example.com",
        password: "password1234",
      },
    });

    expect(UUID_V7_REGEX.test(parseRecordIdPart(result.user.id))).toBe(true);

    const accounts = await built.adapter.findMany<Record<string, unknown>>({
      model: "account",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(accounts).toHaveLength(1);
    expect(ULID_REGEX.test(parseRecordIdPart(String(accounts[0]?.id)))).toBe(true);

    const sessions = await built.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: result.user.id }],
    });
    expect(sessions).toHaveLength(1);
    expect(RANDOM_ID_REGEX.test(parseRecordIdPart(String(sessions[0]?.id)))).toBe(true);
  });

  it("rejects unsupported record-id formats from resolver", async () => {
    const built = await setupFormatCase(() => "uuidv4" as never);

    await expect(
      built.adapter.create({
        model: "user",
        data: buildUserSeed({
          name: "Invalid Format User",
          email: "invalid.id.format@example.com",
          emailVerified: false,
        }),
      }),
    ).rejects.toThrow(/Unsupported recordIdFormat "uuidv4"/);
  });
});
