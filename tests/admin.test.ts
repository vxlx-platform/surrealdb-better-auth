import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import type { Surreal } from "surrealdb";
import type { DBAdapter } from "@better-auth/core/db/adapter";

import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

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

  function cookieHeaderFromSetCookie(setCookie: string | null): string {
    if (!setCookie) {
      throw new Error("Missing Set-Cookie header from sign-in response");
    }
    return setCookie
      .split(",")
      .map((chunk) => chunk.trim().split(";")[0])
      .filter(Boolean)
      .join("; ");
  }

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

    const signInResponse = (await auth.api.signInEmail({
      asResponse: true,
      body: {
        email: adminEmail,
        password: adminPassword,
      },
    } as any)) as Response;

    return {
      cookie: cookieHeaderFromSetCookie(signInResponse.headers.get("set-cookie")),
    };
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
});
