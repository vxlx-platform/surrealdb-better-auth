import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { BoundQuery, DateTime, RecordId, StringRecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
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
      return new BoundQuery("CREATE ONLY user CONTENT $data RETURN AFTER;", {
        data,
      });
    },
  };
};

const createMockClient = (queryResult: unknown = [[]]): MockClient => ({
  query: vi.fn().mockResolvedValue(queryResult),
  create: vi.fn(() => createMockCreateQuery()),
  beginTransaction: vi.fn(),
  isFeatureSupported: vi.fn(() => false),
});

const sessionDate = new Date("2026-03-13T12:00:00.000Z");

const sessionWriteData = (userId: unknown) => ({
  token: "session-token",
  userId,
  expiresAt: sessionDate,
  createdAt: sessionDate,
  updatedAt: sessionDate,
});

describe("Adapter Core - Record ID Strictness", () => {
  it("accepts strict record-id variants for id operators and normalizes bindings to RecordId", async () => {
    const client = createMockClient([[]]);
    const adapter = createAdapter(client);

    await adapter.findMany({
      model: "user",
      limit: 20,
      where: [
        { field: "id", operator: "eq", value: "user:eq-1" },
        {
          field: "id",
          operator: "ne",
          value: new StringRecordId("user:ne-1").toString(),
          connector: "AND",
        },
        {
          field: "id",
          operator: "in",
          value: [new RecordId("user", "in-1").toString(), "user:in-2"],
          connector: "AND",
        },
        {
          field: "id",
          operator: "not_in",
          value: [new StringRecordId("user:notin-1").toString()],
          connector: "AND",
        },
      ],
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [, bindings] = client.query.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const bindingValues = Object.values(bindings);

    const scalarRecordIds = bindingValues.filter(
      (value): value is RecordId => value instanceof RecordId
    );
    expect(scalarRecordIds.length).toBeGreaterThanOrEqual(2);

    const arrayRecordIds = bindingValues.filter(Array.isArray) as unknown[][];
    expect(arrayRecordIds).toHaveLength(2);
    expect(
      arrayRecordIds.every((list) =>
        list.every((value) => value instanceof RecordId)
      )
    ).toBe(true);
  });

  it("rejects bare logical ids across id-based CRUD operations", async () => {
    const client = createMockClient();
    const adapter = createAdapter(client);

    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "abc123" }],
      })
    ).rejects.toThrow('Invalid record id "abc123"');

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "id", operator: "eq", value: "abc123" }],
      })
    ).rejects.toThrow('Invalid record id "abc123"');

    await expect(
      adapter.count({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "abc123" }],
      })
    ).rejects.toThrow('Invalid record id "abc123"');

    await expect(
      adapter.update({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "abc123" }],
        update: { name: "Updated" },
      })
    ).rejects.toThrow('Invalid record id "abc123"');

    await expect(
      adapter.delete({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "abc123" }],
      })
    ).rejects.toThrow('Invalid record id "abc123"');

    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects malformed and wrong-table id values for primary id filters", async () => {
    const malformedClient = createMockClient();
    const malformedAdapter = createAdapter(malformedClient);

    for (const invalidId of ["user:", ":abc"]) {
      await expect(
        malformedAdapter.findOne({
          model: "user",
          where: [{ field: "id", operator: "eq", value: invalidId }],
        })
      ).rejects.toThrow("Invalid record id");
    }
    await expect(
      malformedAdapter.findOne({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "" }],
      })
    ).rejects.toThrow('Expected a Surreal record id for user, received "".');

    const mismatchClient = createMockClient();
    const mismatchAdapter = createAdapter(mismatchClient);
    await expect(
      mismatchAdapter.findOne({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "session:s-1" }],
      })
    ).rejects.toThrow('references table "session", expected "user"');

    expect(malformedClient.query).not.toHaveBeenCalled();
    expect(mismatchClient.query).not.toHaveBeenCalled();
  });

  it("enforces strict record ids on reference fields for where clauses", async () => {
    const bareReferenceClient = createMockClient();
    const bareReferenceAdapter = createAdapter(bareReferenceClient);
    await expect(
      bareReferenceAdapter.findMany({
        model: "session",
        limit: 10,
        where: [{ field: "userId", operator: "eq", value: "u-1" }],
      })
    ).rejects.toThrow('Invalid record id "u-1"');

    const mismatchedReferenceClient = createMockClient();
    const mismatchedReferenceAdapter = createAdapter(mismatchedReferenceClient);
    await expect(
      mismatchedReferenceAdapter.findMany({
        model: "session",
        limit: 10,
        where: [{ field: "userId", operator: "eq", value: "account:a-1" }],
      })
    ).rejects.toThrow('references table "account", expected "user"');

    expect(bareReferenceClient.query).not.toHaveBeenCalled();
    expect(mismatchedReferenceClient.query).not.toHaveBeenCalled();
  });

  it("enforces strict record ids on reference fields for create and update payloads", async () => {
    const createClient = createMockClient();
    const createAdapterInstance = createAdapter(createClient);
    await expect(
      createAdapterInstance.create({
        model: "session",
        data: sessionWriteData("u-1"),
      })
    ).rejects.toThrow('Invalid record id "u-1"');

    const updateClient = createMockClient();
    const updateAdapterInstance = createAdapter(updateClient);
    await expect(
      updateAdapterInstance.update({
        model: "session",
        where: [{ field: "id", operator: "eq", value: "session:s-1" }],
        update: { userId: "account:a-1" },
      })
    ).rejects.toThrow('references table "account", expected "user"');

    expect(createClient.query).not.toHaveBeenCalled();
    expect(updateClient.query).not.toHaveBeenCalled();
  });

  it("cannot bypass create id enforcement by supplying explicit primary ids", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const client = createMockClient([
        [
          {
            id: new StringRecordId("user:generated-1"),
            email: "manual-id@example.com",
            name: "Manual Id",
            emailVerified: false,
            createdAt: new DateTime("2026-03-13T12:00:00.000Z"),
            updatedAt: new DateTime("2026-03-13T12:00:00.000Z"),
          },
        ],
      ]);
      const adapter = createAdapter(client);

      const created = await adapter.create<Record<string, unknown>>({
        model: "user",
        data: {
          id: "user:manual-id-1",
          email: "manual-id@example.com",
          name: "Manual Id",
          emailVerified: false,
          createdAt: sessionDate,
          updatedAt: sessionDate,
        },
      });

      expect(client.query).toHaveBeenCalledTimes(1);
      const [, bindings] = client.query.mock.calls[0] as [
        string,
        { data: Record<string, unknown> },
      ];
      expect(bindings.data.id).toBeUndefined();
      expect(String(created.id)).toBe("user:generated-1");
      expect(String(created.id)).not.toBe("user:manual-id-1");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('rejects invalid record-id entries inside "in" arrays for id and reference filters', async () => {
    const idInClient = createMockClient();
    const idInAdapter = createAdapter(idInClient);
    await expect(
      idInAdapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "id", operator: "in", value: ["user:u-1", "bad-id"] }],
      })
    ).rejects.toThrow('Invalid record id "bad-id"');

    const refInClient = createMockClient();
    const refInAdapter = createAdapter(refInClient);
    await expect(
      refInAdapter.findMany({
        model: "session",
        limit: 10,
        where: [
          { field: "userId", operator: "in", value: ["user:u-1", "bad-id"] },
        ],
      })
    ).rejects.toThrow('Invalid record id "bad-id"');

    expect(idInClient.query).not.toHaveBeenCalled();
    expect(refInClient.query).not.toHaveBeenCalled();
  });

  it("returns full canonical record ids for id and reference fields in outputs", async () => {
    const client = createMockClient([
      [
        {
          id: new RecordId("session", "s-1"),
          userId: new StringRecordId("user:u-1"),
          token: "session-token",
          expiresAt: new DateTime("2026-03-13T12:00:00.000Z"),
          createdAt: new DateTime("2026-03-13T12:00:00.000Z"),
          updatedAt: new DateTime("2026-03-13T12:00:00.000Z"),
          ipAddress: null,
          userAgent: null,
        },
      ],
    ]);
    const adapter = createAdapter(client);

    const found = await adapter.findOne<Record<string, unknown>>({
      model: "session",
      where: [{ field: "id", operator: "eq", value: "session:s-1" }],
    });

    expect(found).not.toBeNull();
    expect(String(found?.id)).toMatch(/^session:/);
    expect(String(found?.id)).not.toBe("s-1");
    expect(String(found?.userId)).toMatch(/^user:/);
    expect(String(found?.userId)).not.toBe("u-1");
    expect(new StringRecordId(String(found?.id)).toString()).toMatch(
      /^session:/
    );
    expect(new StringRecordId(String(found?.userId)).toString()).toMatch(
      /^user:/
    );
    expect(found?.expiresAt).toBeInstanceOf(Date);
  });

  it("normalizes valid reference ids to RecordId for writes", async () => {
    const client = createMockClient([
      [
        {
          id: new RecordId("session", "s-1"),
          userId: new RecordId("user", "u-1"),
          token: "session-token",
          expiresAt: new DateTime("2026-03-13T12:00:00.000Z"),
          createdAt: new DateTime("2026-03-13T12:00:00.000Z"),
          updatedAt: new DateTime("2026-03-13T12:00:00.000Z"),
          ipAddress: null,
          userAgent: null,
        },
      ],
    ]);
    const adapter = createAdapter(client);

    await adapter.create({
      model: "session",
      data: sessionWriteData("user:u-1"),
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [, bindings] = client.query.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(bindings.data.userId).toBeInstanceOf(RecordId);
  });
});
