import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

describe("Adapter Batch Operations (updateMany & deleteMany)", () => {
  let db: Surreal;
  let adapter: DBAdapter;

  beforeAll(async () => {
    // Initialize the raw adapter for database-level CRUD testing
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

  describe("updateMany", () => {
    it("updates multiple records and returns the correct modified count", async () => {
      // 1. Seed 5 users: 3 unverified, 2 verified
      const users = [
        { name: "User 1", email: "u1@test.com", emailVerified: false },
        { name: "User 2", email: "u2@test.com", emailVerified: false },
        { name: "User 3", email: "u3@test.com", emailVerified: false },
        { name: "User 4", email: "u4@test.com", emailVerified: true },
        { name: "User 5", email: "u5@test.com", emailVerified: true },
      ];

      for (const user of users) {
        await adapter.create({
          model: "user",
          data: { ...user, createdAt: new Date(), updatedAt: new Date() },
        });
      }

      // 2. Perform batch update to verify all unverified users
      const modifiedCount = await adapter.updateMany({
        model: "user",
        where: [{ field: "emailVerified", operator: "eq", value: false }],
        update: { emailVerified: true, updatedAt: new Date() },
      });

      // 3. Assert the adapter returns the exact number of rows updated
      expect(modifiedCount).toBe(3);

      // 4. Verify the database state actually reflects the update
      const allUsers = await adapter.findMany<Record<string, unknown>>({ model: "user" });
      const verifiedUsers = allUsers.filter((u) => u.emailVerified === true);

      expect(verifiedUsers).toHaveLength(5); // All 5 should now be verified
    });
  });

  describe("deleteMany", () => {
    it("deletes multiple records based on date conditions (e.g., expired sessions)", async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 1000 * 60 * 60 * 24); // 1 day ago
      const futureDate = new Date(now.getTime() + 1000 * 60 * 60 * 24); // 1 day in future

      // 1. Seed 4 sessions: 2 expired (past), 2 active (future)
      const sessions = [
        { token: "exp_1", expiresAt: pastDate, userId: "user_1" },
        { token: "exp_2", expiresAt: pastDate, userId: "user_2" },
        { token: "act_1", expiresAt: futureDate, userId: "user_3" },
        { token: "act_2", expiresAt: futureDate, userId: "user_4" },
      ];

      for (const session of sessions) {
        await adapter.create({
          model: "session",
          data: { ...session, createdAt: new Date(), updatedAt: new Date() },
        });
      }

      // 2. Perform batch delete for sessions where expiresAt < now
      const deletedCount = await adapter.deleteMany({
        model: "session",
        where: [{ field: "expiresAt", operator: "lt", value: now }],
      });

      // 3. Assert the adapter returns the exact number of rows deleted
      expect(deletedCount).toBe(2);

      // 4. Verify the database state only contains the active sessions
      const remainingSessions = await adapter.findMany<Record<string, unknown>>({
        model: "session",
        sortBy: { field: "token", direction: "asc" },
      });

      expect(remainingSessions).toHaveLength(2);
      expect(remainingSessions[0]!.token as string).toBe("act_1");
      expect(remainingSessions[1]!.token as string).toBe("act_2");
    });

    it("deletes multiple records using the 'in' operator", async () => {
      // 1. Seed records
      for (let i = 1; i <= 5; i++) {
        await adapter.create({
          model: "account",
          data: {
            providerId: `provider_${i}`,
            accountId: `acc_${i}`,
            userId: `user_${i}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }

      const targets = ["provider_2", "provider_4"];

      // 2. Delete specific accounts
      const deletedCount = await adapter.deleteMany({
        model: "account",
        where: [{ field: "providerId", operator: "in", value: targets }],
      });

      expect(deletedCount).toBe(2);

      const remaining = await adapter.count({ model: "account" });
      expect(remaining).toBe(3);
    });
  });
});
