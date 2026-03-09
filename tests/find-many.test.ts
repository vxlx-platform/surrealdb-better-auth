import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

describe("Adapter findMany - Pagination, Sorting & Filtering", () => {
  let db: Surreal;
  let adapter: DBAdapter;

  beforeAll(async () => {
    // We only need the raw adapter for this, no plugins required
    const built = await buildAdapter();
    db = built.db;
    adapter = built.adapter;
    await ensureSchema(db, adapter, built.builtConfig);
  });

  beforeEach(async () => {
    await truncateAuthTables(db);

    // Seed the database with 5 predictable records
    const users = [
      { name: "Alice", email: "alice@example.com", createdAt: new Date("2024-01-01") },
      { name: "Bob", email: "bob@example.com", createdAt: new Date("2024-01-02") },
      { name: "Charlie", email: "charlie@example.com", createdAt: new Date("2024-01-03") },
      { name: "Diana", email: "diana@example.com", createdAt: new Date("2024-01-04") },
      { name: "Eve", email: "eve@example.com", createdAt: new Date("2024-01-05") },
    ];

    for (const user of users) {
      await adapter.create({
        model: "user",
        data: { ...user, emailVerified: true, updatedAt: new Date() },
      });
    }
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it("applies a strict limit to the result set", async () => {
    const results = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      limit: 2, // Should only return 2 out of the 5 seeded records
    });

    expect(results).toHaveLength(2);
  });

  it("applies offset (START) correctly with sorting", async () => {
    // 1. Establish the baseline sorted order (Alice, Bob, Charlie, Diana, Eve)
    const allUsers = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "asc" },
    });

    expect(allUsers).toHaveLength(5);
    expect(allUsers[0]!.name as string).toBe("Alice");
    expect(allUsers[1]!.name as string).toBe("Bob");

    // 2. Test offset: skip the first 2 (Alice, Bob)
    // It should start at Charlie and return the remaining 3 records.
    const offsetUsers = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "asc" },
      offset: 2,
    });

    expect(offsetUsers).toHaveLength(3);
    expect(offsetUsers[0]!.name as string).toBe("Charlie");
    expect(offsetUsers[1]!.name as string).toBe("Diana");
    expect(offsetUsers[2]!.name as string).toBe("Eve");
  });

  it("successfully combines limit, offset, and sortBy for true pagination", async () => {
    // Imagine we are on Page 2, and Page Size is 2.
    // Sorted by name DESCENDING: Eve, Diana, Charlie, Bob, Alice
    // Offset 2, Limit 2 -> Skip Eve & Diana, return Charlie & Bob.

    const paginatedUsers = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "desc" },
      limit: 2,
      offset: 2,
    });

    expect(paginatedUsers).toHaveLength(2);
    expect(paginatedUsers[0]!.name as string).toBe("Charlie");
    expect(paginatedUsers[1]!.name as string).toBe("Bob");
  });

  it("filters records using the 'in' operator array correctly", async () => {
    const targetEmails = ["alice@example.com", "eve@example.com"];

    const results = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "in", value: targetEmails }],
      sortBy: { field: "name", direction: "asc" }, // Ensure predictable return order
    });

    // Should exactly return Alice and Eve
    expect(results).toHaveLength(2);
    expect(results[0]!.name as string).toBe("Alice");
    expect(results[1]!.name as string).toBe("Eve");
  });

  it("handles complex multi-condition arrays (AND logic by default)", async () => {
    const results = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [
        { field: "emailVerified", operator: "eq", value: true },
        // Dates were seeded sequentially from Jan 1st to Jan 5th
        { field: "createdAt", operator: "gte", value: new Date("2024-01-03") },
        { field: "createdAt", operator: "lte", value: new Date("2024-01-04") },
      ],
      sortBy: { field: "name", direction: "asc" },
    });

    // Should only return Charlie (Jan 3) and Diana (Jan 4)
    expect(results).toHaveLength(2);
    expect(results[0]!.name as string).toBe("Charlie");
    expect(results[1]!.name as string).toBe("Diana");
  });
});
