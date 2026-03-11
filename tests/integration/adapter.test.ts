import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { UserRow } from "../../src/types";
import { makeUserSeed } from "../__helpers__/factory";
import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";

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
    if (db) await db.close();
  });

  it("creates a user record and returns a normalized id", async () => {
    const seed = makeUserSeed({ emailVerified: true });

    const result = await adapter.create<UserRow>({
      model: "user",
      data: seed,
    });

    expect(result).toBeDefined();
    expect(result.id).toEqual(expect.any(String));
    expect(result.id).not.toMatch(/^user:/);
    expect(result.name).toBe(seed.name);
    expect(result.email).toBe(seed.email);
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

  it("shapes unique constraint violations clearly for duplicate email writes", async () => {
    await adapter.create<UserRow>({
      model: "user",
      data: {
        name: "First Duplicate",
        email: "duplicate@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await expect(
      adapter.create({
        model: "user",
        data: {
          name: "Second Duplicate",
          email: "duplicate@example.com",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/Unique constraint violation while creating a record in "user"/);
  });

  it("rejects queries that reference an unknown field", async () => {
    await expect(
      adapter.findMany({
        model: "user",
        sortBy: {
          field: "notARealField",
          direction: "asc",
        },
      }),
    ).rejects.toThrow(/Field "notARealField" is not defined for model "user"/);
  });

  it("finds a record by logical id", async () => {
    const user = await adapter.create<UserRow>({
      model: "user",
      data: {
        name: "Find One User",
        email: "findone@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const found = await adapter.findOne<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
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

    await adapter.create<UserRow>({
      model: "user",
      data: {
        name: "Alpha",
        email: "alpha@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const users = (await adapter.findMany({
      model: "user",
      sortBy: { field: "email", direction: "asc" },
    })) as UserRow[];

    expect(users).toHaveLength(2);
    expect(users.map((user) => user.email)).toEqual(["alpha@example.com", "beta@example.com"]);
  });

  it("updates a record by logical id", async () => {
    const user = await adapter.create<UserRow>({
      model: "user",
      data: {
        name: "Original Name",
        email: "update@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const updated = await adapter.update<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
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
    const user = await adapter.create<UserRow>({
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
      where: [{ field: "id", operator: "eq", value: user.id }],
    });

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
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

  it("commits writes inside adapter.transaction", async () => {
    await adapter.transaction(async (trx) => {
      await trx.create({
        model: "user",
        data: {
          name: "Transaction One",
          email: "tx-1@example.com",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await trx.create({
        model: "user",
        data: {
          name: "Transaction Two",
          email: "tx-2@example.com",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    const users = await adapter.findMany<UserRow>({
      model: "user",
      sortBy: { field: "email", direction: "asc" },
    });

    expect(users.map((user) => user.email)).toEqual(["tx-1@example.com", "tx-2@example.com"]);
  });

  it("rolls back writes when adapter.transaction throws", async () => {
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({
          model: "user",
          data: {
            name: "Rollback User",
            email: "rollback@example.com",
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });

        throw new Error("rollback this transaction");
      }),
    ).rejects.toThrow("rollback this transaction");

    const count = await adapter.count({ model: "user" });
    expect(count).toBe(0);
  });
});
