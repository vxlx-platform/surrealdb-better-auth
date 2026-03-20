import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/server";
import type { RunningTestServer } from "../../__helpers__/server";
import { withSuppressedConsoleError } from "../../__helpers__/suppress-console-error";

type AdminFields = {
  role?: string;
  banned?: boolean;
  banReason?: string | null;
  banExpires?: Date | null;
};

type UserRow = {
  id: string;
  email: string;
  role?: string;
  banned?: boolean;
  banReason?: string | null;
  banExpires?: Date | null;
};

type AdminApi = {
  signUpEmail: (input: {
    body: {
      email: string;
      password: string;
      name: string;
      image?: string | undefined;
    };
    asResponse?: boolean | undefined;
  }) => Promise<{ user: { id: string; email: string } & AdminFields } | Response>;
  signInEmail: (input: {
    body: {
      email: string;
      password: string;
      rememberMe?: boolean | undefined;
      callbackURL?: string | undefined;
    };
    asResponse?: boolean | undefined;
  }) => Promise<{ user: { id: string; email: string } } | Response>;
  createUser: (input: {
    headers?: Headers | undefined;
    body: {
      email: string;
      password?: string | undefined;
      name: string;
      role?: string | string[] | undefined;
      data?: Record<string, unknown> | undefined;
    };
  }) => Promise<{ user: { id: string; email: string } & AdminFields }>;
  listUsers: (input: {
    headers?: Headers | undefined;
    query?: {
      searchValue?: string | undefined;
      searchField?: "email" | "name" | undefined;
      searchOperator?: "contains" | "starts_with" | "ends_with" | undefined;
      limit?: string | number | undefined;
      offset?: string | number | undefined;
      sortBy?: string | undefined;
      sortDirection?: "asc" | "desc" | undefined;
      filterField?: string | undefined;
      filterValue?: string | number | boolean | string[] | number[] | undefined;
      filterOperator?:
        | "eq"
        | "ne"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "in"
        | "not_in"
        | "contains"
        | "starts_with"
        | "ends_with"
        | undefined;
    };
  }) => Promise<{ users: Array<{ id: string; email: string } & AdminFields>; total: number }>;
  setRole: (input: {
    headers?: Headers | undefined;
    body: {
      userId: string;
      role: string | string[];
    };
  }) => Promise<{ user: { id: string; email: string } & AdminFields }>;
  setUserPassword: (input: {
    headers?: Headers | undefined;
    body: {
      userId: string;
      newPassword: string;
    };
  }) => Promise<{ status: boolean }>;
  banUser: (input: {
    headers?: Headers | undefined;
    body: {
      userId: string;
      banReason?: string | undefined;
      banExpiresIn?: number | undefined;
    };
  }) => Promise<{ user: { id: string; email: string } & AdminFields }>;
  unbanUser: (input: {
    headers?: Headers | undefined;
    body: {
      userId: string;
    };
  }) => Promise<{ user: { id: string; email: string } & AdminFields }>;
  getUser: (input: {
    headers?: Headers | undefined;
    query: {
      id: string;
    };
  }) => Promise<{ id: string; email: string } & AdminFields>;
};

const asAdminApi = (api: unknown): AdminApi => api as AdminApi;

const signUpAdminAndGetHeaders = async (
  context: AuthContext,
  api: AdminApi,
  email: string,
  password: string,
  name: string,
) => {
  const response = (await api.signUpEmail({
    body: {
      email,
      password,
      name,
    },
    asResponse: true,
  })) as Response;

  const body = (await response.json()) as {
    user: { id: string; email: string } & AdminFields;
  };

  await context.adapter.update({
    model: "user",
    where: [{ field: "id", operator: "eq", value: body.user.id }],
    update: { role: "admin" },
  });
  const headers = await context.test.getAuthHeaders({ userId: body.user.id });

  return { headers };
};

describe("Live DB - Admin Plugin", () => {
  let context: AuthContext | undefined;
  let server: RunningTestServer | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live admin context was not initialized.");
    }
    return context;
  };

  const requireServer = (): RunningTestServer => {
    if (!server) {
      throw new Error("Live admin server was not initialized.");
    }
    return server;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
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
    server = await startTestServer(requireContext().auth);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  it("includes admin user fields in generated schema output", async () => {
    const context = requireContext();
    const authOptions = context.auth.options as BetterAuthOptions;
    const schema = await context.adapter.createSchema?.(authOptions, "admin-plugin-live.surql");

    expect(schema?.code).toBeDefined();
    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? role ON TABLE user TYPE [^;]+;/);
    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? banned ON TABLE user TYPE [^;]+;/);
    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? banReason ON TABLE user TYPE [^;]+;/);
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? banExpires ON TABLE user TYPE [^;]+;/,
    );
  });

  it("applies admin default role on sign-up and persists role fields", async () => {
    const context = requireContext();
    const api = asAdminApi(context.auth.api);

    const signUp = (await api.signUpEmail({
      body: {
        email: "live-admin-default-role@example.com",
        password: "live-admin-password",
        name: "Live Admin",
      },
    })) as { user: { id: string; email: string } & AdminFields };

    expect(signUp.user.role).toBe("user");

    const dbUser = await context.adapter.findOne<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signUp.user.id }],
    });
    expect(dbUser?.role).toBe("user");
    expect(dbUser?.banned ?? false).toBe(false);
  });

  it("allows authenticated admins to create users and list users", async () => {
    const context = requireContext();
    const api = asAdminApi(context.auth.api);
    const { headers } = await signUpAdminAndGetHeaders(
      context,
      api,
      "live-admin-create@example.com",
      "live-admin-password",
      "Live Admin Creator",
    );

    const created = await api.createUser({
      headers,
      body: {
        email: "live-admin-created-user@example.com",
        password: "created-password",
        name: "Created By Admin",
        role: "user",
      },
    });
    expect(created.user.role).toBe("user");

    const listed = await api.listUsers({
      headers,
      query: {
        searchField: "email",
        searchOperator: "contains",
        searchValue: "live-admin-created-user",
      },
    });
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.users.some((user) => user.email === created.user.email)).toBe(true);
  });

  it("allows authenticated admins to set roles and retrieve updated users", async () => {
    const context = requireContext();
    const api = asAdminApi(context.auth.api);
    const { headers } = await signUpAdminAndGetHeaders(
      context,
      api,
      "live-admin-set-role@example.com",
      "live-admin-password",
      "Live Role Admin",
    );

    const created = await api.createUser({
      headers,
      body: {
        email: "live-admin-role-target@example.com",
        password: "target-password",
        name: "Role Target",
        role: "user",
      },
    });

    const updated = await api.setRole({
      headers,
      body: {
        userId: created.user.id,
        role: "admin",
      },
    });
    expect(updated.user.role).toBe("admin");

    const fetched = await api.getUser({
      headers,
      query: {
        id: created.user.id,
      },
    });
    expect(fetched.role).toBe("admin");
  });

  it("allows authenticated admins to ban and unban users", async () => {
    const context = requireContext();
    const api = asAdminApi(context.auth.api);
    const { headers } = await signUpAdminAndGetHeaders(
      context,
      api,
      "live-admin-ban-user@example.com",
      "live-admin-password",
      "Live Ban Admin",
    );

    const created = await api.createUser({
      headers,
      body: {
        email: "live-admin-ban-target@example.com",
        password: "target-password",
        name: "Ban Target",
        role: "user",
      },
    });

    const banned = await api.banUser({
      headers,
      body: {
        userId: created.user.id,
        banReason: "policy-test",
        banExpiresIn: 60,
      },
    });
    expect(banned.user.banned).toBe(true);
    expect(banned.user.banReason).toBe("policy-test");

    const bannedRow = await context.adapter.findOne<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: created.user.id }],
    });
    expect(bannedRow?.banned).toBe(true);

    const unbanned = await api.unbanUser({
      headers,
      body: {
        userId: created.user.id,
      },
    });
    expect(unbanned.user.banned).toBe(false);

    const unbannedRow = await context.adapter.findOne<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: created.user.id }],
    });
    expect(unbannedRow?.banned ?? false).toBe(false);
  });

  it("allows admin to reset another user's password via setUserPassword", async () => {
    const context = requireContext();
    const api = asAdminApi(context.auth.api);
    const { headers } = await signUpAdminAndGetHeaders(
      context,
      api,
      "live-admin-reset-password@example.com",
      "live-admin-password",
      "Live Reset Admin",
    );

    const targetEmail = "live-reset-target@example.com";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword123!";

    const created = (await api.signUpEmail({
      body: {
        email: targetEmail,
        password: oldPassword,
        name: "Reset Target",
      },
    })) as { user: { id: string; email: string } & AdminFields };

    const resetResult = await api.setUserPassword({
      headers,
      body: {
        userId: created.user.id,
        newPassword,
      },
    });
    expect(resetResult.status).toBe(true);

    await withSuppressedConsoleError(
      async () =>
        await expect(
          api.signInEmail({
            body: {
              email: targetEmail,
              password: oldPassword,
            },
          }),
        ).rejects.toThrow(),
      /invalid password/i,
    );

    const newSignIn = (await api.signInEmail({
      body: {
        email: targetEmail,
        password: newPassword,
      },
    })) as { user: { id: string; email: string } };
    expect(newSignIn.user.id).toBe(created.user.id);
  });

  it("rejects protected admin endpoints when headers are missing", async () => {
    const base = requireServer().url("/api/auth/admin");

    const listUsersResponse = await fetch(`${base}/list-users?limit=10`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    expect([401, 403]).toContain(listUsersResponse.status);

    const setRoleResponse = await fetch(`${base}/set-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user:missing",
        role: "admin",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    expect([401, 403]).toContain(setRoleResponse.status);
  });
});
