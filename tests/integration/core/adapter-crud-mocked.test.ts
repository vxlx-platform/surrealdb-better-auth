import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  beginTransaction: ReturnType<typeof vi.fn>;
  isFeatureSupported: ReturnType<typeof vi.fn>;
};

const createAdapter = (client: MockClient) => {
  const auth = betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "01234567890123456789012345678901",
    database: surrealAdapter(client as never),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  return factory(options);
};

describe("Adapter Core - CRUD", () => {
  it("creates a user record and returns a full Surreal record id", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          id: new RecordId("user", "abc123"),
          email: "test@example.com",
          name: "Test User",
          emailVerified: false,
          createdAt: new DateTime("2026-03-13T12:00:00.000Z"),
          updatedAt: new DateTime("2026-03-13T12:00:00.000Z"),
        },
      ],
    ]);

    const client = {
      query,
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;

    const adapter = createAdapter(client);
    expect(adapter.options?.adapterConfig.transaction).toBe(false);

    const created = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        email: "test@example.com",
        name: "Test User",
        emailVerified: false,
      },
    });

    expect(created.id).toBe("user:abc123");
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("rejects create calls that include an explicit id", async () => {
    const client = {
      query: vi.fn(),
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;

    const adapter = createAdapter(client);

    await expect(
      adapter.create({
        model: "user",
        data: {
          id: "user:manual",
          email: "manual@example.com",
          name: "Manual",
          emailVerified: false,
        } as Record<string, unknown>,
        forceAllowId: true,
      }),
    ).rejects.toThrow('forceAllowId is not supported for model "user"');

    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects bare logical ids in where clauses", async () => {
    const client = {
      query: vi.fn(),
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;

    const adapter = createAdapter(client);

    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "id", value: "abc123" }],
      }),
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("builds where operators using SurrealDB expressions", async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    const client = {
      query,
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;

    const adapter = createAdapter(client);

    await adapter.findMany({
      model: "user",
      limit: 20,
      where: [
        { field: "email", operator: "contains", value: "@example.com" },
        { field: "name", operator: "starts_with", value: "Test", connector: "AND" },
        { field: "name", operator: "ends_with", value: "User", connector: "OR" },
        {
          field: "id",
          operator: "in",
          value: ["user:abc123", "user:def456"],
          connector: "AND",
        },
        {
          field: "id",
          operator: "not_in",
          value: ["user:zzz999"],
          connector: "AND",
        },
      ],
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, bindings] = query.mock.calls[0] as [string, Record<string, unknown>];
    expect(sql).toContain("CONTAINS");
    expect(sql).toContain("string::starts_with");
    expect(sql).toContain("string::ends_with");
    expect(sql).toContain("INSIDE");
    expect(sql).toContain("NOT(");

    const arrays = Object.values(bindings).filter(Array.isArray);
    expect(arrays).toHaveLength(2);
    for (const recordIds of arrays) {
      expect(recordIds).toBeInstanceOf(Array);
      expect((recordIds as unknown[])[0]).toBeInstanceOf(StringRecordId);
    }
  });

  it('rejects non-array values for "in" and non-string values for string operators', async () => {
    const client = {
      query: vi.fn(),
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;

    const adapter = createAdapter(client);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "id", operator: "in", value: "user:abc123" }],
      }),
    ).rejects.toThrow(/array/i);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "starts_with", value: 123 }],
      }),
    ).rejects.toThrow('Operator "starts_with" requires a string value.');

    expect(client.query).not.toHaveBeenCalled();
  });
});
