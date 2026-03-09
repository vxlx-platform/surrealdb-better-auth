import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { admin, testUtils } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import type { Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables } from "../test-utils";

const _getAuthType = () =>
  betterAuth({
    database: {} as any,
    emailAndPassword: { enabled: true },
    plugins: [
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        roles: {
          user: userAc,
          creator: userAc,
          admin: adminAc,
        },
      }),
      testUtils(),
    ],
  });

type AuthWithAdmin = ReturnType<typeof _getAuthType>;

describe("Admin Plugin - Adapter Integration", () => {
  let db: Surreal;
  let auth: AuthWithAdmin;
  let adapter: DBAdapter;
  let builtConfig: Awaited<ReturnType<typeof buildAdapter>>["builtConfig"];

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: false },
      {
        baseURL: "http://localhost",
        emailAndPassword: { enabled: true },
        plugins: [
          admin({
            defaultRole: "user",
            adminRoles: ["admin"],
            roles: {
              user: userAc,
              creator: userAc,
              admin: adminAc,
            },
          }),
          testUtils(),
        ],
      },
    );

    db = built.db;
    auth = built.auth as unknown as AuthWithAdmin;
    adapter = built.adapter;
    builtConfig = built.builtConfig;

    await ensureSchema(db, adapter, builtConfig);
  }, 60_000);

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createAdminSessionHeaders() {
    const adminEmail = "admin@example.com";
    const adminPassword = "Password123!";

    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Admin User",
        email: adminEmail,
        password: adminPassword,
      },
    });

    // Promote this user so protected admin endpoints can be exercised.
    await adapter.update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signUp.user.id }],
      update: { role: "admin", updatedAt: new Date() },
    });

    const ctx = await auth.$context;
    return ctx.test.getAuthHeaders({ userId: signUp.user.id });
  }

  it("generates admin user fields in schema output", async () => {
    const result = await adapter.createSchema!(builtConfig, "admin.surql");
    const sql = result.code;

    expect(sql).toContain("DEFINE FIELD role ON user TYPE");
    expect(sql).toContain("DEFINE FIELD banned ON user TYPE");
    expect(sql).toContain("DEFINE FIELD banReason ON user TYPE");
    expect(sql).toContain("DEFINE FIELD banExpires ON user TYPE");
  });

  it("supports listUsers, setRole for user/creator/admin, banUser, and unbanUser", async () => {
    const adminHeaders = await createAdminSessionHeaders();

    const regularUser = await auth.api.signUpEmail({
      body: {
        name: "Regular User",
        email: "regular@example.com",
        password: "Password123!",
      },
    });

    const creatorUser = await auth.api.signUpEmail({
      body: {
        name: "Creator User",
        email: "creator@example.com",
        password: "Password123!",
      },
    });

    const listedBefore = await auth.api.listUsers({
      headers: adminHeaders,
      query: {},
    });
    expect(listedBefore.users.length).toBeGreaterThanOrEqual(2);

    const setAdminRoleResult = await auth.api.setRole({
      headers: adminHeaders,
      body: {
        userId: regularUser.user.id,
        role: "admin",
      },
    });
    expect(setAdminRoleResult.user.role).toBe("admin");

    // set user role back to user
    const setUserRoleResult = await auth.api.setRole({
      headers: adminHeaders,
      body: {
        userId: regularUser.user.id,
        role: "user",
      },
    });
    expect(setUserRoleResult.user.role).toBe("user");

    // set creator role
    const setCreatorRoleResult = await auth.api.setRole({
      headers: adminHeaders,
      body: {
        userId: creatorUser.user.id,
        role: "creator",
      },
    });
    expect(setCreatorRoleResult.user.role).toBe("creator");

    await auth.api.banUser({
      headers: adminHeaders,
      body: {
        userId: regularUser.user.id,
        banReason: "policy-test",
        banExpiresIn: 60,
      },
    });

    const bannedUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: regularUser.user.id }],
    });
    expect(bannedUser).not.toBeNull();
    expect(bannedUser?.banned).toBe(true);

    await auth.api.unbanUser({
      headers: adminHeaders,
      body: {
        userId: regularUser.user.id,
      },
    });

    const unbannedUser = await adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: regularUser.user.id }],
    });
    expect(unbannedUser).not.toBeNull();
    expect(unbannedUser?.banned).toBe(false);
  }, 60_000);

  it("allows admin to reset another user's password via setUserPassword", async () => {
    const adminHeaders = await createAdminSessionHeaders();

    const targetEmail = "reset-target@example.com";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword123!";

    const created = await auth.api.signUpEmail({
      body: {
        name: "Reset Target",
        email: targetEmail,
        password: oldPassword,
      },
    });

    const resetResult = await auth.api.setUserPassword({
      headers: adminHeaders,
      body: {
        userId: created.user.id,
        newPassword,
      },
    });
    expect(resetResult.status).toBe(true);

    await expect(
      auth.api.signInEmail({
        body: {
          email: targetEmail,
          password: oldPassword,
        },
      }),
    ).rejects.toThrow();

    const newSignIn = await auth.api.signInEmail({
      body: {
        email: targetEmail,
        password: newPassword,
      },
    });
    expect(newSignIn.user.id).toBe(created.user.id);
    expect(newSignIn.token).toBeDefined();
  });

});
