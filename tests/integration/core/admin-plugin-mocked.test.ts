import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { setCookieToHeader } from "better-auth/cookies";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";
import type { DBAdapterInstance } from "@better-auth/core/db/adapter";

import { surrealAdapter } from "../../../src";

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  beginTransaction: ReturnType<typeof vi.fn>;
  isFeatureSupported: ReturnType<typeof vi.fn>;
};

type UserRow = {
  id: RecordId;
  email: string;
  name: string;
  emailVerified: boolean;
  role?: string;
  banned?: boolean;
  banReason?: string | null;
  banExpires?: DateTime | null;
  image?: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};

type AccountRow = {
  id: RecordId;
  userId: StringRecordId;
  accountId: string;
  providerId: string;
  password?: string;
  createdAt: DateTime;
  updatedAt: DateTime;
};

type SessionRow = {
  id: RecordId;
  userId: StringRecordId;
  token: string;
  expiresAt: DateTime;
  createdAt: DateTime;
  updatedAt: DateTime;
};

type AdminFields = {
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
  getUser: (input: {
    headers?: Headers | undefined;
    query: {
      id: string;
    };
  }) => Promise<{ id: string; email: string } & AdminFields>;
};

const nowDateTime = () => new DateTime("2026-03-14T00:00:00.000Z");

const asRecordIdString = (value: unknown) =>
  value instanceof RecordId || value instanceof StringRecordId
    ? value.toString()
    : typeof value === "string"
      ? value
      : "";

const pickString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asAdminApi = (api: unknown): AdminApi => api as AdminApi;

const createAdminAuth = (client: MockClient) =>
  betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "01234567890123456789012345678901",
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => password,
        verify: async ({ hash, password }) => hash === password,
      },
    },
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
    database: surrealAdapter(client as never),
  });

const createStatefulAdminMockClient = () => {
  const usersById = new Map<string, UserRow>();
  const accountsByUserId = new Map<string, AccountRow>();
  const sessionsByToken = new Map<string, SessionRow>();

  const findUserById = (id: unknown) => usersById.get(asRecordIdString(id)) ?? null;

  const filterUsers = (sql: string, bindings: Record<string, unknown>) => {
    const users = [...usersById.values()];
    const values = Object.values(bindings);
    const hasContains = sql.includes(" contains ");
    const hasStartsWith = sql.includes("string::starts_with");
    const hasEndsWith = sql.includes("string::ends_with");
    const hasEmailField = sql.includes("`email`") || sql.includes("email");
    const hasNameField = sql.includes("`name`") || sql.includes("name");
    const matchText = values.find(
      (value) =>
        typeof value === "string" && !value.startsWith("user:") && !value.includes("credential"),
    );
    const emailText = values.find(
      (value): value is string => typeof value === "string" && value.includes("@"),
    );
    const idValue = values.find(
      (value) => value instanceof StringRecordId || value instanceof RecordId,
    );

    if (idValue) {
      const user = findUserById(idValue);
      return user ? [user] : [];
    }

    if (typeof emailText === "string") {
      if (hasContains) return users.filter((user) => user.email.includes(emailText));
      if (hasStartsWith) return users.filter((user) => user.email.startsWith(emailText));
      if (hasEndsWith) return users.filter((user) => user.email.endsWith(emailText));
      return users.filter((user) => user.email === emailText);
    }

    if (typeof matchText === "string" && hasEmailField) {
      if (hasContains) return users.filter((user) => user.email.includes(matchText));
      if (hasStartsWith) return users.filter((user) => user.email.startsWith(matchText));
      if (hasEndsWith) return users.filter((user) => user.email.endsWith(matchText));
      return users.filter((user) => user.email === matchText);
    }

    if (typeof matchText === "string" && hasNameField) {
      if (hasContains) return users.filter((user) => user.name.includes(matchText));
      if (hasStartsWith) return users.filter((user) => user.name.startsWith(matchText));
      if (hasEndsWith) return users.filter((user) => user.name.endsWith(matchText));
      return users.filter((user) => user.name === matchText);
    }

    return users;
  };

  const query = vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const queryBindings = bindings ?? {};
    const values = Object.values(queryBindings);

    if (normalizedSql.startsWith("select value") && normalizedSql.includes("from user")) {
      const idValue = values.find(
        (value) => value instanceof StringRecordId || value instanceof RecordId,
      );
      if (!idValue) return [[]];
      const user = findUserById(idValue);
      return [[user?.id ?? null].filter(Boolean)];
    }

    if (normalizedSql.startsWith("select count() as total from user")) {
      const users = filterUsers(normalizedSql, queryBindings);
      return [[{ total: users.length }]];
    }

    if (normalizedSql.startsWith("select") && normalizedSql.includes("from user")) {
      const users = filterUsers(normalizedSql, queryBindings);
      const offsetRaw = queryBindings.offset;
      const limitRaw = queryBindings.limit;
      const offset = typeof offsetRaw === "number" ? offsetRaw : 0;
      const limit = typeof limitRaw === "number" ? limitRaw : users.length;
      return [users.slice(offset, offset + limit)];
    }

    if (normalizedSql.startsWith("select") && normalizedSql.includes("from account")) {
      const userIdValue = values.find(
        (value) => value instanceof StringRecordId || value instanceof RecordId,
      );
      const accountId = values.find(
        (value): value is string => typeof value === "string" && value.includes("@"),
      );
      const providerId = values.find(
        (value) => typeof value === "string" && value === "credential",
      );
      if (providerId !== "credential") return [[]];

      if (accountId) {
        const account = [...accountsByUserId.values()].find(
          (entry) => entry.providerId === "credential" && entry.accountId === accountId,
        );
        return [[account].filter(Boolean)];
      }

      if (!userIdValue) return [[]];
      const account = accountsByUserId.get(asRecordIdString(userIdValue));
      return [[account].filter(Boolean)];
    }

    if (normalizedSql.startsWith("select") && normalizedSql.includes("from session")) {
      const token = values.find((value) => typeof value === "string" && value.length > 10);
      const userId = values.find(
        (value) => value instanceof StringRecordId || value instanceof RecordId,
      );

      if (typeof token === "string") {
        const session = sessionsByToken.get(token);
        return [[session].filter(Boolean)];
      }

      if (userId) {
        const matches = [...sessionsByToken.values()].filter(
          (session) => session.userId.toString() === asRecordIdString(userId),
        );
        return [matches];
      }
      return [[]];
    }

    if (normalizedSql.includes("create only user")) {
      const data = (queryBindings.data ?? {}) as Record<string, unknown>;
      const id = new RecordId("user", `u-${usersById.size + 1}`);
      const row: UserRow = {
        id,
        email: pickString(data.email).toLowerCase(),
        name: pickString(data.name),
        emailVerified: Boolean(data.emailVerified ?? false),
        role: pickString(data.role, "user"),
        banned: Boolean(data.banned ?? false),
        banReason: (data.banReason as string | null | undefined) ?? null,
        banExpires:
          data.banExpires instanceof DateTime
            ? data.banExpires
            : data.banExpires instanceof Date
              ? new DateTime(data.banExpires.toISOString())
              : null,
        ...(typeof data.image === "string" || data.image === null ? { image: data.image } : {}),
        createdAt: data.createdAt instanceof DateTime ? data.createdAt : nowDateTime(),
        updatedAt: data.updatedAt instanceof DateTime ? data.updatedAt : nowDateTime(),
      };
      usersById.set(id.toString(), row);
      return [[row]];
    }

    if (normalizedSql.includes("create only account")) {
      const data = (queryBindings.data ?? {}) as Record<string, unknown>;
      const id = new RecordId("account", `a-${accountsByUserId.size + 1}`);
      const userId = new StringRecordId(asRecordIdString(data.userId));
      const row: AccountRow = {
        id,
        userId,
        accountId: pickString(data.accountId, userId.toString()),
        providerId: pickString(data.providerId, "credential"),
        ...(typeof data.password === "string" ? { password: data.password } : {}),
        createdAt: data.createdAt instanceof DateTime ? data.createdAt : nowDateTime(),
        updatedAt: data.updatedAt instanceof DateTime ? data.updatedAt : nowDateTime(),
      };
      accountsByUserId.set(userId.toString(), row);
      return [[row]];
    }

    if (normalizedSql.includes("create only session")) {
      const data = (queryBindings.data ?? {}) as Record<string, unknown>;
      const id = new RecordId("session", `s-${sessionsByToken.size + 1}`);
      const token = pickString(data.token, `token-${sessionsByToken.size + 1}`);
      const userId = new StringRecordId(asRecordIdString(data.userId));
      const row: SessionRow = {
        id,
        token,
        userId,
        expiresAt: data.expiresAt instanceof DateTime ? data.expiresAt : nowDateTime(),
        createdAt: data.createdAt instanceof DateTime ? data.createdAt : nowDateTime(),
        updatedAt: data.updatedAt instanceof DateTime ? data.updatedAt : nowDateTime(),
      };
      sessionsByToken.set(token, row);
      return [[row]];
    }

    if (normalizedSql === "update $target merge $update return after;") {
      const target = queryBindings.target;
      const update = (queryBindings.update ?? {}) as Record<string, unknown>;
      const user = findUserById(target);
      if (!user) return [[]];
      const updated: UserRow = {
        ...user,
        ...update,
        updatedAt: nowDateTime(),
      };
      usersById.set(updated.id.toString(), updated);
      return [[updated]];
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  });

  const client = {
    query,
    beginTransaction: vi.fn(),
    isFeatureSupported: vi.fn(() => false),
  } satisfies MockClient;

  const setUserRole = (userId: string, role: string) => {
    const user = usersById.get(userId);
    if (!user) return;
    usersById.set(userId, {
      ...user,
      role,
      updatedAt: nowDateTime(),
    });
  };

  return { client, setUserRole };
};

const createAdminHeaders = async (
  api: AdminApi,
  setUserRole: (userId: string, role: string) => void,
  user: { email: string; password: string; name: string },
) => {
  const signUpResponse = (await api.signUpEmail({
    body: user,
    asResponse: true,
  })) as Response;

  const signUpBody = (await signUpResponse.json()) as {
    user: { id: string; email: string } & AdminFields;
  };

  setUserRole(signUpBody.user.id, "admin");

  const headers = new Headers();
  setCookieToHeader(headers)({ response: signUpResponse });

  return { headers, signUpBody };
};

describe("Admin Plugin - Mocked", () => {
  it("includes admin user fields in generated schema output", async () => {
    const { client } = createStatefulAdminMockClient();
    const auth = createAdminAuth(client);

    const authOptions = auth.options as BetterAuthOptions;
    const adapterFactory = authOptions.database as DBAdapterInstance;
    const adapter = adapterFactory(authOptions);
    const schema = await adapter.createSchema?.(authOptions, "admin-plugin-mocked.surql");

    expect(schema?.code).toBeDefined();
    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? role ON TABLE user TYPE [^;]+;/);
    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? banned ON TABLE user TYPE [^;]+;/);
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? banReason ON TABLE user TYPE [^;]+;/,
    );
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? banExpires ON TABLE user TYPE [^;]+;/,
    );
  });

  it("applies default role to sign-up users", async () => {
    const { client } = createStatefulAdminMockClient();
    const auth = createAdminAuth(client);
    const api = asAdminApi(auth.api);

    const signUp = (await api.signUpEmail({
      body: {
        email: "mock-admin-default-role@example.com",
        password: "mock-password",
        name: "Admin Default Role",
      },
    })) as { user: { id: string; email: string } & AdminFields };

    expect(signUp.user.role).toBe("user");
  });

  it("allows authenticated admins to create users and list users", async () => {
    const { client, setUserRole } = createStatefulAdminMockClient();
    const auth = createAdminAuth(client);
    const api = asAdminApi(auth.api);
    const { headers } = await createAdminHeaders(api, setUserRole, {
      email: "mock-admin-create@example.com",
      password: "mock-password",
      name: "Mock Admin",
    });

    const created = await api.createUser({
      headers,
      body: {
        email: "mock-admin-created-user@example.com",
        password: "mock-password",
        name: "Created User",
        role: "user",
      },
    });

    expect(created.user.email).toBe("mock-admin-created-user@example.com");
    expect(created.user.role).toBe("user");

    const listed = await api.listUsers({
      headers,
      query: {
        searchField: "email",
        searchOperator: "contains",
        searchValue: "mock-admin-created-user",
      },
    });

    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.users.some((user) => user.email === created.user.email)).toBe(true);
  });

  it("allows authenticated admins to set roles and read updated user data", async () => {
    const { client, setUserRole } = createStatefulAdminMockClient();
    const auth = createAdminAuth(client);
    const api = asAdminApi(auth.api);
    const { headers } = await createAdminHeaders(api, setUserRole, {
      email: "mock-admin-set-role@example.com",
      password: "mock-password",
      name: "Role Admin",
    });

    const created = await api.createUser({
      headers,
      body: {
        email: "mock-role-target@example.com",
        password: "mock-password",
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

  it("rejects protected admin endpoints without auth headers", async () => {
    const { client } = createStatefulAdminMockClient();
    const auth = createAdminAuth(client);
    const api = asAdminApi(auth.api);

    await expect(
      api.listUsers({
        query: {
          limit: 10,
        },
      }),
    ).rejects.toThrow();

    await expect(
      api.setRole({
        body: {
          userId: "user:u-1",
          role: "admin",
        },
      }),
    ).rejects.toThrow();
  });
});
