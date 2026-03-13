import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import {
  BoundQuery,
  RecordId,
  StringRecordId,
  Surreal,
} from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import type { SessionRow, UserRow } from "../types";
import { surrealAdapter } from "../../src";

type SurrealLike = {
  query: Surreal["query"];
  forkSession?: () => Promise<unknown>;
  isFeatureSupported?: (feature: unknown) => boolean;
};

const TEST_SECRET = "unit-test-secret-that-is-at-least-thirty-two-characters";
const UUID_ID = "019cdcb0-d8c6-7650-8393-4d869986ae00";

const parseRecordIdLikeVariants = [
  UUID_ID,
  `user:${UUID_ID}`,
  `user:⟨${UUID_ID}⟩`,
  `user:u'${UUID_ID}'`,
  new StringRecordId(`user:${UUID_ID}`),
  new RecordId("user", UUID_ID),
];

const buildAdapter = (db: SurrealLike): DBAdapter => {
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: TEST_SECRET,
    emailAndPassword: {
      enabled: true,
    },
    database: surrealAdapter(db as unknown as Surreal),
  });

  const builtConfig = auth.options as BetterAuthOptions;
  const adapterFactory = builtConfig.database as DBAdapterInstance;
  return adapterFactory(builtConfig) as DBAdapter;
};

const findRecordIdBinding = (value: unknown): RecordId | null => {
  if (value instanceof RecordId) return value;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecordIdBinding(entry);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = findRecordIdBinding(entry);
      if (found) return found;
    }
  }

  return null;
};

const expectUserRecordId = (value: unknown, context: string) => {
  const rid = findRecordIdBinding(value);
  expect(rid, context).not.toBeNull();
  expect(rid?.table.name, `${context}: table`).toBe("user");
  expect(String(rid?.id), `${context}: id`).toBe(UUID_ID);
};

describe("Unit - Record ID Normalization", () => {
  it("normalizes id lookups across record-id forms and strips id outputs consistently", async () => {
    const query = vi.fn(async (input: string | BoundQuery<unknown[]>) => {
      expect(input).toBeInstanceOf(BoundQuery);
      const bound = input as BoundQuery;
      expect(bound.query).toContain("SELECT * FROM $target");
      expectUserRecordId(bound.bindings.target, "findOne target binding");

      return [
        [
          {
            id: parseRecordIdLikeVariants[query.mock.calls.length - 1],
            name: "Record ID User",
            email: "record-id@example.com",
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ];
    });

    const adapter = buildAdapter({
      query: query as unknown as Surreal["query"],
    });

    for (const variant of parseRecordIdLikeVariants) {
      const found = await adapter.findOne<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: variant as unknown }],
      });

      expect(found).not.toBeNull();
      expect(found?.id).toBe(UUID_ID);
    }
  });

  it("normalizes reference-field inputs for create/find and strips reference outputs", async () => {
    const createQueries: BoundQuery[] = [];
    const selectQueries: BoundQuery[] = [];

    const query = vi.fn(async (input: string | BoundQuery<unknown[]>) => {
      expect(input).toBeInstanceOf(BoundQuery);
      const bound = input as BoundQuery;

      if (bound.query.startsWith("CREATE ")) {
        createQueries.push(bound);
      } else if (bound.query.startsWith("SELECT * FROM ")) {
        selectQueries.push(bound);
      }

      const token = `session_${Math.max(createQueries.length, selectQueries.length)}`;
      return [
        [
          {
            id: new RecordId("session", token),
            userId: new RecordId("user", UUID_ID),
            token,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddress: null,
            userAgent: null,
          },
        ],
      ];
    });

    const adapter = buildAdapter({
      query: query as unknown as Surreal["query"],
    });

    for (const variant of parseRecordIdLikeVariants) {
      const created = await adapter.create<SessionRow>({
        model: "session",
        data: {
          token: `token-${Math.random()}`,
          userId: variant as unknown as string,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
          ipAddress: null,
          userAgent: null,
        },
      });
      expect(created.userId).toBe(UUID_ID);

      const found = await adapter.findMany<SessionRow>({
        model: "session",
        where: [{ field: "userId", operator: "eq", value: variant as unknown }],
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.userId).toBe(UUID_ID);
    }

    expect(createQueries).toHaveLength(parseRecordIdLikeVariants.length);
    for (const bound of createQueries) {
      expectUserRecordId(bound.bindings.data, "create data.userId binding");
    }

    expect(selectQueries).toHaveLength(parseRecordIdLikeVariants.length);
    for (const bound of selectQueries) {
      expectUserRecordId(bound.bindings, "findMany where userId binding");
    }
  });
});
