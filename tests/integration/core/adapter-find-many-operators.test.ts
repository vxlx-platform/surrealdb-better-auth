import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

describe("Adapter Core - findMany Pagination/Sorting/Filtering", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live operator context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext();
  });

  beforeEach(async () => {
    const context = requireContext();
    await context.reset();

    const users = [
      { name: "Alice", email: "alice@example.com", createdAt: new Date("2024-01-01T00:00:00.000Z") },
      { name: "Bob", email: "bob@example.com", createdAt: new Date("2024-01-02T00:00:00.000Z") },
      { name: "Charlie", email: "charlie@example.com", createdAt: new Date("2024-01-03T00:00:00.000Z") },
      { name: "Diana", email: "diana@example.com", createdAt: new Date("2024-01-04T00:00:00.000Z") },
      { name: "Eve", email: "eve@example.com", createdAt: new Date("2024-01-05T00:00:00.000Z") },
    ];

    for (const user of users) {
      await context.adapter.create({
        model: "user",
        data: { ...user, emailVerified: true, updatedAt: new Date() },
      });
    }
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("applies a strict limit to the result set", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("applies offset (START) correctly with sorting", async () => {
    const context = requireContext();

    const allUsers = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "asc" },
    });
    expect(allUsers).toHaveLength(5);
    expect(allUsers[0]?.name).toBe("Alice");
    expect(allUsers[1]?.name).toBe("Bob");

    const offsetUsers = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "asc" },
      offset: 2,
    });
    expect(offsetUsers).toHaveLength(3);
    expect(offsetUsers[0]?.name).toBe("Charlie");
    expect(offsetUsers[1]?.name).toBe("Diana");
    expect(offsetUsers[2]?.name).toBe("Eve");
  });

  it("combines limit, offset, and sortBy for true pagination", async () => {
    const context = requireContext();
    const paginatedUsers = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "name", direction: "desc" },
      limit: 2,
      offset: 2,
    });

    expect(paginatedUsers).toHaveLength(2);
    expect(paginatedUsers[0]?.name).toBe("Charlie");
    expect(paginatedUsers[1]?.name).toBe("Bob");
  });

  it("filters using 'in' operator", async () => {
    const context = requireContext();
    const targetEmails = ["alice@example.com", "eve@example.com"];

    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "in", value: targetEmails }],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("Alice");
    expect(results[1]?.name).toBe("Eve");
  });

  it("filters using 'not_in' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "not_in", value: ["alice@example.com", "eve@example.com"] }],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results.map((user) => user.name)).toEqual(["Bob", "Charlie", "Diana"]);
  });

  it("handles multi-condition arrays (AND logic by default)", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [
        { field: "emailVerified", operator: "eq", value: true },
        { field: "createdAt", operator: "gte", value: new Date("2024-01-03T00:00:00.000Z") },
        { field: "createdAt", operator: "lte", value: new Date("2024-01-04T00:00:00.000Z") },
      ],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("Charlie");
    expect(results[1]?.name).toBe("Diana");
  });

  it("filters using 'ne' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "ne", value: "alice@example.com" }],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results).toHaveLength(4);
    expect(results.map((user) => user.name)).toEqual(["Bob", "Charlie", "Diana", "Eve"]);
  });

  it("filters using 'gt' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "createdAt", operator: "gt", value: new Date("2024-01-03T00:00:00.000Z") }],
      sortBy: { field: "createdAt", direction: "asc" },
    });

    expect(results).toHaveLength(2);
    expect(results.map((user) => user.name)).toEqual(["Diana", "Eve"]);
  });

  it("filters using 'lt' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "createdAt", operator: "lt", value: new Date("2024-01-03T00:00:00.000Z") }],
      sortBy: { field: "createdAt", direction: "asc" },
    });

    expect(results).toHaveLength(2);
    expect(results.map((user) => user.name)).toEqual(["Alice", "Bob"]);
  });

  it("filters using 'starts_with' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "starts_with", value: "char" }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Charlie");
  });

  it("filters using 'ends_with' operator", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "ends_with", value: "@example.com" }],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results).toHaveLength(5);
    expect(results.map((user) => user.name)).toEqual(["Alice", "Bob", "Charlie", "Diana", "Eve"]);
  });

  it("handles OR connector behavior explicitly", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [
        { field: "email", operator: "eq", value: "alice@example.com" },
        { field: "email", operator: "eq", value: "eve@example.com", connector: "OR" },
      ],
      sortBy: { field: "name", direction: "asc" },
    });

    expect(results).toHaveLength(2);
    expect(results.map((user) => user.name)).toEqual(["Alice", "Eve"]);
  });

  it("rejects unsupported operators explicitly", async () => {
    const context = requireContext();
    await expect(
      context.adapter.findMany<Record<string, unknown>>({
        model: "user",
        where: [{ field: "email", operator: "between" as never, value: ["a", "b"] }],
      }),
    ).rejects.toThrow(/Unsupported where operator "between"/);
  });

  it('rejects non-array values for the "in" operator', async () => {
    const context = requireContext();
    await expect(
      context.adapter.findMany<Record<string, unknown>>({
        model: "user",
        where: [{ field: "email", operator: "in", value: "alice@example.com" as never }],
      }),
    ).rejects.toThrow(/(Operator "in" requires an array value|Value must be an array)/);
  });
});
