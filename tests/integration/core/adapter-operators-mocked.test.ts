import type { DBAdapterInstance, Where } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { RecordId, StringRecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  beginTransaction: ReturnType<typeof vi.fn>;
  isFeatureSupported: ReturnType<typeof vi.fn>;
};

type OperatorCase = {
  operator:
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "in"
    | "not_in"
    | "contains"
    | "starts_with"
    | "ends_with";
  field: string;
  value: Where["value"];
  token: RegExp;
};

const operatorCases: OperatorCase[] = [
  { operator: "eq", field: "name", value: "Alice", token: / = \$bind__/ },
  { operator: "ne", field: "name", value: "Alice", token: / != \$bind__/ },
  { operator: "lt", field: "createdAt", value: new Date("2026-03-13T12:00:00.000Z"), token: / < \$bind__/ },
  { operator: "lte", field: "createdAt", value: new Date("2026-03-13T12:00:00.000Z"), token: / <= \$bind__/ },
  { operator: "gt", field: "createdAt", value: new Date("2026-03-13T12:00:00.000Z"), token: / > \$bind__/ },
  { operator: "gte", field: "createdAt", value: new Date("2026-03-13T12:00:00.000Z"), token: / >= \$bind__/ },
  { operator: "in", field: "name", value: ["Alice", "Bob"], token: / INSIDE \$bind__/ },
  { operator: "not_in", field: "name", value: ["Alice", "Bob"], token: /NOT\(.*INSIDE \$bind__/s },
  { operator: "contains", field: "name", value: "lic", token: / CONTAINS \$bind__/ },
  { operator: "starts_with", field: "name", value: "Al", token: /string::starts_with/ },
  { operator: "ends_with", field: "name", value: "ce", token: /string::ends_with/ },
];

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

const createClient = (): MockClient => ({
  query: vi.fn(),
  beginTransaction: vi.fn(),
  isFeatureSupported: vi.fn(() => false),
});

const createdUser = {
  id: new RecordId("user", "u-1"),
  email: "alice@example.com",
  name: "Alice",
};

describe("Adapter Core - CRUD Where Operators", () => {
  it.each(operatorCases)(
    'supports "$operator" across find/count/update/delete operator paths',
    async ({ operator, field, value, token }) => {
      const client = createClient();
      client.query
        .mockResolvedValueOnce([[]]) // findOne
        .mockResolvedValueOnce([[]]) // findMany
        .mockResolvedValueOnce([[{ total: 0 }]]) // count
        .mockResolvedValueOnce([[{ total: 1 }]]) // updateMany count pass
        .mockResolvedValueOnce([[]]) // updateMany write pass
        .mockResolvedValueOnce([[{ total: 1 }]]) // deleteMany count pass
        .mockResolvedValueOnce([[]]) // deleteMany write pass
        .mockResolvedValueOnce([[new StringRecordId("user:u-1")]]) // update target lookup
        .mockResolvedValueOnce([[createdUser]]) // update write pass
        .mockResolvedValueOnce([[new StringRecordId("user:u-1")]]) // delete target lookup
        .mockResolvedValueOnce([[]]); // delete write pass

      const adapter = createAdapter(client);
      const where: Where[] = [{ field, operator, value }];

      await adapter.findOne({
        model: "user",
        where: [...where],
      });

      await adapter.findMany({
        model: "user",
        limit: 10,
        where: [...where],
      });

      await adapter.count({
        model: "user",
        where: [...where],
      });

      await adapter.updateMany({
        model: "user",
        where: [...where],
        update: { name: "Updated" },
      });

      await adapter.deleteMany({
        model: "user",
        where: [...where],
      });

      await adapter.update({
        model: "user",
        where: [...where],
        update: { name: "Updated" },
      });

      await adapter.delete({
        model: "user",
        where: [...where],
      });

      const calls = client.query.mock.calls as Array<[string, Record<string, unknown>]>;
      expect(calls).toHaveLength(11);

      expect(calls[0]?.[0]).toMatch(token); // findOne WHERE
      expect(calls[1]?.[0]).toMatch(token); // findMany WHERE
      expect(calls[2]?.[0]).toMatch(token); // count WHERE
      expect(calls[4]?.[0]).toMatch(token); // updateMany WHERE
      expect(calls[6]?.[0]).toMatch(token); // deleteMany WHERE
      expect(calls[7]?.[0]).toMatch(token); // update id lookup WHERE
      expect(calls[9]?.[0]).toMatch(token); // delete id lookup WHERE
    },
  );

  it("supports mixed AND/OR connectors in one where clause", async () => {
    const client = createClient();
    client.query.mockResolvedValueOnce([[]]);
    const adapter = createAdapter(client);

    await adapter.findMany({
      model: "user",
      limit: 10,
      where: [
        { field: "email", operator: "contains", value: "@example.com" },
        { field: "name", operator: "starts_with", value: "Al", connector: "AND" },
        { field: "name", operator: "ends_with", value: "ce", connector: "OR" },
      ],
    });

    const [sql] = client.query.mock.calls[0] as [string];
    expect(sql).toContain("AND");
    expect(sql).toContain("OR");
    expect(sql).toContain("string::starts_with");
    expect(sql).toContain("string::ends_with");
  });

  it('rejects non-array values for "in" and "not_in"', async () => {
    const client = createClient();
    const adapter = createAdapter(client);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "in", value: "Alice" }],
      }),
    ).rejects.toThrow(/array/i);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "not_in", value: "Alice" }],
      }),
    ).rejects.toThrow(/array/i);

    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects non-string values for "starts_with" and "ends_with"', async () => {
    const client = createClient();
    const adapter = createAdapter(client);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "starts_with", value: 123 }],
      }),
    ).rejects.toThrow('Operator "starts_with" requires a string value.');

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "ends_with", value: 123 }],
      }),
    ).rejects.toThrow('Operator "ends_with" requires a string value.');

    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects unsupported operators before running a query", async () => {
    const client = createClient();
    const adapter = createAdapter(client);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 10,
        where: [{ field: "name", operator: "between" as never, value: "Alice" }],
      }),
    ).rejects.toThrow('Unsupported where operator "between".');

    expect(client.query).not.toHaveBeenCalled();
  });
});
