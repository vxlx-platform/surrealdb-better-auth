import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { buildUserSeed } from "../../__helpers__/fixtures";

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

    const updatedAt = new Date("2024-01-06T00:00:00.000Z");
    const users = [
      buildUserSeed({
        name: "Alice",
        email: "alice@example.com",
        emailVerified: true,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt,
      }),
      buildUserSeed({
        name: "Bob",
        email: "bob@example.com",
        emailVerified: true,
        createdAt: new Date("2024-01-02T00:00:00.000Z"),
        updatedAt,
      }),
      buildUserSeed({
        name: "Charlie",
        email: "charlie@example.com",
        emailVerified: true,
        createdAt: new Date("2024-01-03T00:00:00.000Z"),
        updatedAt,
      }),
      buildUserSeed({
        name: "Diana",
        email: "diana@example.com",
        emailVerified: true,
        createdAt: new Date("2024-01-04T00:00:00.000Z"),
        updatedAt,
      }),
      buildUserSeed({
        name: "Eve",
        email: "eve@example.com",
        emailVerified: true,
        createdAt: new Date("2024-01-05T00:00:00.000Z"),
        updatedAt,
      }),
    ];

    for (const user of users) {
      await context.adapter.create({
        model: "user",
        data: user,
      });
    }
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("applies stable pagination via sortBy + limit + offset", async () => {
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

  it("filters using a set operator ('in')", async () => {
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

  it("filters using string operators ('starts_with'/'ends_with')", async () => {
    const context = requireContext();
    const startsWith = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "starts_with", value: "char" }],
    });
    expect(startsWith).toHaveLength(1);
    expect(startsWith[0]?.name).toBe("Charlie");

    const endsWith = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "ends_with", value: "@example.com" }],
      sortBy: { field: "name", direction: "asc" },
    });
    expect(endsWith).toHaveLength(5);
    expect(endsWith.map((user) => user.name)).toEqual(["Alice", "Bob", "Charlie", "Diana", "Eve"]);
  });

  it("handles mixed connector behavior (AND default + explicit OR)", async () => {
    const context = requireContext();
    const results = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [
        { field: "emailVerified", operator: "eq", value: true },
        { field: "createdAt", operator: "gte", value: new Date("2024-01-05T00:00:00.000Z"), connector: "AND" },
        { field: "email", operator: "eq", value: "alice@example.com", connector: "OR" },
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
