import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hasLiveSurrealEndpoint, setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

const describeLive = hasLiveSurrealEndpoint ? describe : describe.skip;

describeLive("Live DB - Better Auth CRUD", () => {
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
    const now = new Date();
    const created = await context.adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        email: "live-crud@example.com",
        name: "Live CRUD",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
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
      update: { name: "Live CRUD Updated" },
    });

    expect(updated?.name).toBe("Live CRUD Updated");

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
});
