import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { buildUserSeed } from "../../__helpers__/fixtures";

describe("Live DB - Better Auth CRUD", () => {
  let context: AuthContext | undefined;
  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live auth context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  it("performs create/find/update/count/delete against a live SurrealDB instance", async () => {
    const context = requireContext();
    const user = buildUserSeed({
      email: "live-crud@example.com",
      name: "Live CRUD",
      emailVerified: false,
    });

    const created = await context.adapter.create<Record<string, unknown>>({
      model: "user",
      data: user,
    });

    expect(created.id).toMatch(/^user:/);
    expect(created.email).toBe("live-crud@example.com");

    const found = await context.adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: created.id as string }],
    });

    expect(found?.id).toBe(created.id);

    const updated = await context.adapter.update<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: created.id as string }],
      update: { name: "CRUD Updated" },
    });

    expect(updated?.name).toBe("CRUD Updated");

    const countBeforeDelete = await context.adapter.count({
      model: "user",
    });
    expect(countBeforeDelete).toBe(1);

    await context.adapter.delete({
      model: "user",
      where: [{ field: "id", operator: "eq", value: created.id as string }],
    });

    const countAfterDelete = await context.adapter.count({
      model: "user",
    });
    expect(countAfterDelete).toBe(0);
  });

  it("supports findMany sorting, pagination, and where operators against live SurrealDB", async () => {
    const context = requireContext();
    const now = new Date();

    for (const [index, name] of ["Alpha User", "Beta User", "Gamma User"].entries()) {
      await context.adapter.create<Record<string, unknown>>({
        model: "user",
        data: buildUserSeed({
          email: `live-operators-${index}@example.com`,
          name,
          emailVerified: index !== 1,
          createdAt: now,
          updatedAt: now,
        }),
      });
    }

    const sorted = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "live-operators-" }],
      sortBy: { field: "name", direction: "asc" },
      limit: 3,
      offset: 0,
    });

    expect(sorted).toHaveLength(3);
    expect(sorted[0]?.name).toBe("Alpha User");
    expect(sorted[1]?.name).toBe("Beta User");
    expect(sorted[2]?.name).toBe("Gamma User");

    const paged = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "live-operators-" }],
      sortBy: { field: "name", direction: "asc" },
      limit: 1,
      offset: 1,
    });
    expect(paged).toHaveLength(1);
    expect(paged[0]?.name).toBe("Beta User");

    const unverified = await context.adapter.findMany<Record<string, unknown>>({
      model: "user",
      where: [
        { field: "emailVerified", operator: "eq", value: false },
        { field: "email", operator: "contains", value: "live-operators-", connector: "AND" },
      ],
      limit: 10,
      offset: 0,
    });
    expect(unverified).toHaveLength(1);
    expect(unverified[0]?.name).toBe("Beta User");
  });

  it("supports updateMany and deleteMany with accurate affected counts", async () => {
    const context = requireContext();
    const now = new Date();
    const createdIds: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      const created = await context.adapter.create<Record<string, unknown>>({
        model: "user",
        data: buildUserSeed({
          email: `live-bulk-${index}@example.com`,
          name: `Bulk ${index}`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        }),
      });
      createdIds.push(String(created.id));
    }

    const updatedCount = await context.adapter.updateMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "live-bulk-" }],
      update: { emailVerified: true },
    });
    expect(updatedCount).toBe(3);

    const verifiedCount = await context.adapter.count({
      model: "user",
      where: [
        { field: "email", operator: "contains", value: "live-bulk-" },
        { field: "emailVerified", operator: "eq", value: true, connector: "AND" },
      ],
    });
    expect(verifiedCount).toBe(3);

    const deletedCount = await context.adapter.deleteMany({
      model: "user",
      where: [{ field: "id", operator: "in", value: createdIds }],
    });
    expect(deletedCount).toBe(3);

    const remaining = await context.adapter.count({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "live-bulk-" }],
    });
    expect(remaining).toBe(0);
  });

  it("rejects bare logical ids in live adapter queries", async () => {
    const context = requireContext();

    await expect(
      context.adapter.findOne({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "not-a-record-id" }],
      }),
    ).rejects.toThrow(/record id/i);
  });
});
