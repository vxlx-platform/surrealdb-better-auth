import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BuiltTestAdapter } from "../../test-utils";

import { setupIntegrationAdapter } from "../../test-utils";

type TestSession = {
  headers: Headers;
  token: string;
};

describe("Auth Flow - Session Management", () => {
  let db: Surreal;
  let auth: BuiltTestAdapter["auth"];
  let adapter: DBAdapter;
  let resetDb: () => Promise<void>;
  let closeDb: () => Promise<true>;

  beforeAll(async () => {
    const built = await setupIntegrationAdapter(
      { debugLogs: false },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );

    db = built.db;
    auth = built.auth;
    adapter = built.adapter;
    resetDb = built.reset;
    closeDb = built.close;
  }, 60_000);

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    if (db) {
      await closeDb();
    }
  });

  const createUserWithSessions = async (count: number) => {
    const now = Date.now();
    const email = `session-${now}-${Math.random().toString(36).slice(2)}@example.com`;

    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Session Test User",
        email,
        password: "session-test-password-123",
      },
    });

    const userId = signUp.user.id;

    await adapter.deleteMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });

    const ctx = await auth.$context;
    const sessions: TestSession[] = [];
    for (let i = 0; i < count; i += 1) {
      const login = await ctx.test.login({ userId });
      sessions.push({
        headers: login.headers as Headers,
        token: login.token,
      });
    }

    return { sessions, userId };
  };

  const getSessionTokensForUser = async (userId: string) => {
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    return rows
      .map((row) => row.token)
      .filter((token): token is string => typeof token === "string");
  };

  it("lists active sessions for the current user", async () => {
    const { sessions, userId } = await createUserWithSessions(2);
    const [current] = sessions;
    if (!current) {
      throw new Error("Expected at least one session");
    }

    const listed = await auth.api.listSessions({
      headers: current.headers,
    });

    const listedTokens = listed.map((session) => session.token);
    const dbTokens = await getSessionTokensForUser(userId);

    expect(listedTokens).toHaveLength(2);
    expect(new Set(listedTokens)).toEqual(new Set(dbTokens));
    expect(new Set(listedTokens)).toEqual(new Set(sessions.map((session) => session.token)));
  });

  it("revokes a specific session token", async () => {
    const { sessions, userId } = await createUserWithSessions(2);
    const [current, target] = sessions;
    if (!current || !target) {
      throw new Error("Expected two sessions");
    }

    const result = await auth.api.revokeSession({
      headers: current.headers,
      body: {
        token: target.token,
      },
    });

    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens).toContain(current.token);
    expect(dbTokens).not.toContain(target.token);
  });

  it("revokes all sessions except the current one", async () => {
    const { sessions, userId } = await createUserWithSessions(3);
    const current = sessions[2];
    if (!current) {
      throw new Error("Expected current session");
    }

    const result = await auth.api.revokeOtherSessions({
      headers: current.headers,
    });

    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens[0]).toBe(current.token);
  });

  it("revokes all sessions for the current user", async () => {
    const { sessions, userId } = await createUserWithSessions(2);
    const [current] = sessions;
    if (!current) {
      throw new Error("Expected current session");
    }

    const result = await auth.api.revokeSessions({
      headers: current.headers,
    });

    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(0);
  });

  it("removes only the current session on sign out", async () => {
    const { sessions, userId } = await createUserWithSessions(2);
    const [current, other] = sessions;
    if (!current || !other) {
      throw new Error("Expected two sessions");
    }

    const result = await auth.api.signOut({
      headers: current.headers,
    });

    expect(result.success).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens).not.toContain(current.token);
    expect(dbTokens).toContain(other.token);
  });
});
