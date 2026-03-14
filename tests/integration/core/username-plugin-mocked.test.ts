import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

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
  username?: string;
  displayUsername?: string;
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

const nowDateTime = () => new DateTime("2026-03-14T00:00:00.000Z");

const asRecordIdString = (value: unknown) =>
  value instanceof RecordId || value instanceof StringRecordId
    ? value.toString()
    : typeof value === "string"
      ? value
      : "";

const pickString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const createUsernameAuth = (client: MockClient) =>
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
    plugins: [username()],
    database: surrealAdapter(client as never),
  });

const createStatefulUsernameMockClient = () => {
  const usersById = new Map<string, UserRow>();
  const accountsByUserId = new Map<string, AccountRow>();
  const sessionsByToken = new Map<string, SessionRow>();

  const findUserByEmail = (email: string) => {
    for (const user of usersById.values()) {
      if (user.email === email) return user;
    }
    return null;
  };

  const findUserByUsername = (candidate: string) => {
    const normalized = candidate.toLowerCase();
    for (const user of usersById.values()) {
      if (user.username?.toLowerCase() === normalized) return user;
    }
    return null;
  };

  const query = vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const values = Object.values(bindings ?? {});

    if (normalizedSql.startsWith("select") && normalizedSql.includes("from user")) {
      if (normalizedSql.includes("select value") && normalizedSql.includes("`id`")) {
        const recordId = values.find(
          (value) => value instanceof StringRecordId || value instanceof RecordId,
        );
        if (!recordId) return [[]];
        const user = usersById.get(asRecordIdString(recordId));
        return [[user?.id ?? null].filter(Boolean)];
      }

      const email = values.find((value) => typeof value === "string" && value.includes("@"));
      if (typeof email === "string") {
        const user = findUserByEmail(email);
        return [[user].filter(Boolean)];
      }

      const username = values.find(
        (value) =>
          typeof value === "string" &&
          !value.includes("@") &&
          value !== "credential" &&
          value !== "password",
      );
      if (typeof username === "string") {
        const user = findUserByUsername(username);
        return [[user].filter(Boolean)];
      }

      const idValue = values.find(
        (value) => value instanceof StringRecordId || value instanceof RecordId,
      );
      if (idValue) {
        const user = usersById.get(asRecordIdString(idValue));
        return [[user].filter(Boolean)];
      }

      return [[]];
    }

    if (normalizedSql.startsWith("select") && normalizedSql.includes("from account")) {
      const userIdValue = values.find(
        (value) => value instanceof StringRecordId || value instanceof RecordId,
      );
      const providerId = values.find(
        (value) => typeof value === "string" && value === "credential",
      );
      if (!userIdValue || providerId !== "credential") return [[]];
      const account = accountsByUserId.get(asRecordIdString(userIdValue));
      return [[account].filter(Boolean)];
    }

    if (normalizedSql.includes("create only user")) {
      const data = (bindings?.data ?? {}) as Record<string, unknown>;
      const id = new RecordId("user", `u-${usersById.size + 1}`);
      const row: UserRow = {
        id,
        email: pickString(data.email),
        name: pickString(data.name),
        emailVerified: Boolean(data.emailVerified ?? false),
        ...(typeof data.username === "string" ? { username: data.username } : {}),
        ...(typeof data.displayUsername === "string"
          ? { displayUsername: data.displayUsername }
          : {}),
        ...(typeof data.image === "string" || data.image === null ? { image: data.image } : {}),
        createdAt: data.createdAt instanceof DateTime ? data.createdAt : nowDateTime(),
        updatedAt: data.updatedAt instanceof DateTime ? data.updatedAt : nowDateTime(),
      };
      usersById.set(id.toString(), row);
      return [[row]];
    }

    if (normalizedSql.includes("create only account")) {
      const data = (bindings?.data ?? {}) as Record<string, unknown>;
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
      const data = (bindings?.data ?? {}) as Record<string, unknown>;
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

    throw new Error(`Unhandled mock query: ${sql}`);
  });

  const client = {
    query,
    beginTransaction: vi.fn(),
    isFeatureSupported: vi.fn(() => false),
  } satisfies MockClient;

  return { client, query };
};

describe("Username Plugin - Mocked", () => {
  it("normalizes username during sign-up and maps displayUsername when omitted", async () => {
    const { client, query } = createStatefulUsernameMockClient();
    const auth = createUsernameAuth(client);

    const result = await auth.api.signUpEmail({
      body: {
        email: "mock-username-signup@example.com",
        password: "mock-password",
        name: "Mock Username User",
        username: "Mixed.Case_User",
      },
    });

    expect((result.user as Record<string, unknown>).username).toBe("mixed.case_user");
    expect((result.user as Record<string, unknown>).displayUsername).toBe("Mixed.Case_User");

    const createUserCall = query.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("create only user"),
    ) as [string, { data: Record<string, unknown> }] | undefined;
    expect(createUserCall).toBeDefined();
    expect(createUserCall?.[1].data.username).toBe("mixed.case_user");
    expect(createUserCall?.[1].data.displayUsername).toBe("Mixed.Case_User");
  });

  it("reports username availability and normalizes lookup input", async () => {
    const { client } = createStatefulUsernameMockClient();
    const auth = createUsernameAuth(client);

    const before = await auth.api.isUsernameAvailable({
      body: {
        username: "Available_Name",
      },
    });
    expect(before.available).toBe(true);

    await auth.api.signUpEmail({
      body: {
        email: "mock-username-availability@example.com",
        password: "mock-password",
        name: "Availability User",
        username: "available_name",
      },
    });

    const after = await auth.api.isUsernameAvailable({
      body: {
        username: "AVAILABLE_NAME",
      },
    });
    expect(after.available).toBe(false);
  });

  it("authenticates signInUsername with normalized username and rejects wrong passwords", async () => {
    const { client, query } = createStatefulUsernameMockClient();
    const auth = createUsernameAuth(client);

    const signUp = await auth.api.signUpEmail({
      body: {
        email: "mock-signin-username@example.com",
        password: "mock-password",
        name: "SignIn Username User",
        username: "signin.user",
      },
    });

    const signIn = await auth.api.signInUsername({
      body: {
        username: "SIGNIN.USER",
        password: "mock-password",
      },
    });

    expect(signIn.user.id).toBe(signUp.user.id);
    expect(signIn.token).toEqual(expect.any(String));

    await expect(
      auth.api.signInUsername({
        body: {
          username: "signin.user",
          password: "wrong-password",
        },
      }),
    ).rejects.toThrow();

    const firstSignInLookup = query.mock.calls.find(
      ([sql, bindings]) =>
        String(sql).toLowerCase().includes("from user") &&
        Object.values((bindings as Record<string, unknown>) ?? {}).includes("signin.user"),
    );
    expect(firstSignInLookup).toBeDefined();
  });

  it("rejects duplicate usernames and invalid username formats", async () => {
    const { client } = createStatefulUsernameMockClient();
    const auth = createUsernameAuth(client);

    await auth.api.signUpEmail({
      body: {
        email: "mock-duplicate-1@example.com",
        password: "mock-password",
        name: "Duplicate One",
        username: "duplicate_user",
      },
    });

    await expect(
      auth.api.signUpEmail({
        body: {
          email: "mock-duplicate-2@example.com",
          password: "mock-password",
          name: "Duplicate Two",
          username: "duplicate_user",
        },
      }),
    ).rejects.toThrow();

    await expect(
      auth.api.isUsernameAvailable({
        body: {
          username: "invalid username",
        },
      }),
    ).rejects.toThrow();
  });
});
