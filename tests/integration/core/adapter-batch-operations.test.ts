import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

describe("Adapter Core - Batch Operations (updateMany/deleteMany)", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live batch operations context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext();
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  describe("updateMany", () => {
    it("updates multiple records and returns the correct modified count", async () => {
      const context = requireContext();
      const now = new Date();
      const users = [
        { name: "User 1", email: "u1@test.com", emailVerified: false },
        { name: "User 2", email: "u2@test.com", emailVerified: false },
        { name: "User 3", email: "u3@test.com", emailVerified: false },
        { name: "User 4", email: "u4@test.com", emailVerified: true },
        { name: "User 5", email: "u5@test.com", emailVerified: true },
      ];

      for (const user of users) {
        await context.adapter.create({
          model: "user",
          data: { ...user, createdAt: now, updatedAt: now },
        });
      }

      const modifiedCount = await context.adapter.updateMany({
        model: "user",
        where: [{ field: "emailVerified", operator: "eq", value: false }],
        update: { emailVerified: true, updatedAt: new Date() },
      });
      expect(modifiedCount).toBe(3);

      const verifiedUsers = await context.adapter.findMany<Record<string, unknown>>({
        model: "user",
        where: [{ field: "emailVerified", operator: "eq", value: true }],
      });
      expect(verifiedUsers).toHaveLength(5);
    });
  });

  describe("deleteMany", () => {
    it("deletes multiple records based on date conditions (e.g., expired sessions)", async () => {
      const context = requireContext();
      const now = new Date();
      const pastDate = new Date(now.getTime() - 1000 * 60 * 60 * 24);
      const futureDate = new Date(now.getTime() + 1000 * 60 * 60 * 24);

      for (const [index, expiresAt] of [pastDate, pastDate, futureDate, futureDate].entries()) {
        await context.adapter.create({
          model: "session",
          data: {
            token: `${index < 2 ? "exp" : "act"}_${index}`,
            expiresAt,
            ipAddress: undefined,
            userAgent: undefined,
            userId: `user:seed_user_${index}`,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const deletedCount = await context.adapter.deleteMany({
        model: "session",
        where: [{ field: "expiresAt", operator: "lt", value: now }],
      });
      expect(deletedCount).toBe(2);

      const remainingSessions = await context.adapter.findMany<Record<string, unknown>>({
        model: "session",
        sortBy: { field: "token", direction: "asc" },
      });
      expect(remainingSessions).toHaveLength(2);
      expect(String(remainingSessions[0]?.token)).toContain("act_");
      expect(String(remainingSessions[1]?.token)).toContain("act_");
    });

    it("deletes multiple records using the 'in' operator", async () => {
      const context = requireContext();
      const now = new Date();

      for (let i = 1; i <= 5; i += 1) {
        await context.adapter.create({
          model: "account",
          data: {
            accountId: `acc_${i}`,
            providerId: `provider_${i}`,
            userId: `user:seed_user_${i}`,
            accessToken: undefined,
            refreshToken: undefined,
            idToken: undefined,
            accessTokenExpiresAt: undefined,
            refreshTokenExpiresAt: undefined,
            scope: undefined,
            password: undefined,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const deletedCount = await context.adapter.deleteMany({
        model: "account",
        where: [{ field: "providerId", operator: "in", value: ["provider_2", "provider_4"] }],
      });
      expect(deletedCount).toBe(2);

      const remaining = await context.adapter.count({ model: "account" });
      expect(remaining).toBe(3);
    });
  });

  describe("reference fields", () => {
    it("rejects writes when a reference field uses the wrong record table", async () => {
      const context = requireContext();

      await expect(
        context.adapter.create({
          model: "session",
          data: {
            token: "bad_ref",
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: undefined,
            userAgent: undefined,
            userId: "account:not-a-user",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/Record id "account:not-a-user".*expected "user"/i);
    });

    it("rejects reference filters when the record table does not match", async () => {
      const context = requireContext();

      await expect(
        context.adapter.findMany<Record<string, unknown>>({
          model: "session",
          where: [{ field: "userId", operator: "eq", value: "account:not-a-user" }],
        }),
      ).rejects.toThrow(/Record id "account:not-a-user".*expected "user"/i);
    });
  });
});
