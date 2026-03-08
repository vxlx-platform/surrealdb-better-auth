import type { DBAdapter } from "@better-auth/core/db/adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Surreal } from "surrealdb";

import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

describe("surrealdb-adapter CRUD", () => {
  let db: Surreal;
  let adapter: DBAdapter;

  beforeAll(async () => {
    const built = await buildAdapter();
    db = built.db;
    adapter = built.adapter;
    await ensureSchema(db, adapter, built.builtConfig);
  });

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates a user record and returns a normalized id", async () => {
    const now = new Date();

    const result = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "Test User",
        email: "test@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(result).toBeDefined();
    expect(result.id).toEqual(expect.any(String));
    expect(result.id).not.toMatch(/^user:/);
    expect(result.name).toBe("Test User");
    expect(result.email).toBe("test@example.com");
    expect(result.emailVerified).toBe(true);
  });

  it("rejects writes when a required field is missing", async () => {
    await expect(
      adapter.create({
        model: "user",
        data: {
          name: "Missing email",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("finds a record by logical id", async () => {
    const user = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "Find One User",
        email: "findone@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const found = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id as string }],
    });

    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      id: user.id,
      name: "Find One User",
      email: "findone@example.com",
      emailVerified: false,
    });
  });

  it("finds many records with ordering", async () => {
    await adapter.create({
      model: "user",
      data: {
        name: "Beta",
        email: "beta@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.create({
      model: "user",
      data: {
        name: "Alpha",
        email: "alpha@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const users = await adapter.findMany<Record<string, unknown>>({
      model: "user",
      sortBy: { field: "email", direction: "asc" },
    });

    expect(users).toHaveLength(2);
    expect(users.map((user) => user.email)).toEqual(["alpha@example.com", "beta@example.com"]);
  });

  it("updates a record by logical id", async () => {
    const user = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "Original Name",
        email: "update@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const updated = await adapter.update<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id as string }],
      update: {
        name: "Updated Name",
        updatedAt: new Date(),
      },
    });

    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({
      id: user.id,
      name: "Updated Name",
      email: "update@example.com",
    });
  });

  it("deletes a record by logical id", async () => {
    const user = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "Delete Me",
        email: "delete@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.delete({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id as string }],
    });

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id as string }],
    });

    expect(found).toBeNull();
  });

  it("counts records after writes", async () => {
    await adapter.create({
      model: "user",
      data: {
        name: "Count One",
        email: "count-1@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.create({
      model: "user",
      data: {
        name: "Count Two",
        email: "count-2@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const count = await adapter.count({ model: "user" });
    expect(count).toBe(2);
  });
});
