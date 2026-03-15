import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setCookieToHeader } from "better-auth/cookies";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

describe("Auth Flow - Session Management", () => {
  let context: AuthContext | undefined;

  type SessionApi = {
    listSessions: (input: { headers: Headers }) => Promise<Array<{ token: string }>>;
    revokeSession: (input: { headers: Headers; body: { token: string } }) => Promise<{ status: boolean }>;
    revokeOtherSessions: (input: { headers: Headers }) => Promise<{ status: boolean }>;
    revokeSessions: (input: { headers: Headers }) => Promise<{ status: boolean }>;
    signOut: (input: { headers: Headers }) => Promise<{ success: boolean } | { status: boolean }>;
  };

  type TestSession = {
    headers: Headers;
    token: string;
  };

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live auth context was not initialized.");
    }
    return context;
  };

  const getSessionApi = (ctx: AuthContext): SessionApi => ctx.auth.api as unknown as SessionApi;

  const createUserWithSessions = async (count: number) => {
    const ctx = requireContext();
    const email = `session-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const signUp = await ctx.auth.api.signUpEmail({
      body: {
        email,
        password: "session-test-password-123",
        name: "Session Test User",
      },
    });

    const userId = signUp.user.id;
    await ctx.adapter.deleteMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });

    const sessions: TestSession[] = [];
    for (let i = 0; i < count; i += 1) {
      const loginResponse = await ctx.auth.api.signInEmail({
        body: {
          email,
          password: "session-test-password-123",
        },
        asResponse: true,
      });
      const loginBody = (await loginResponse.json()) as { token: string };
      const headers = new Headers();
      setCookieToHeader(headers)({ response: loginResponse });
      sessions.push({ headers, token: loginBody.token });
    }

    return { sessions, userId };
  };

  const getSessionTokensForUser = async (userId: string) => {
    const ctx = requireContext();
    const rows = await ctx.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    return rows.map((row) => row.token).filter((token): token is string => typeof token === "string");
  };

  beforeAll(async () => {
    context = await setupAuthContext();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  it("lists active sessions for the current user", async () => {
    const api = getSessionApi(requireContext());
    const { sessions, userId } = await createUserWithSessions(2);
    const current = sessions[0];
    if (!current) throw new Error("Expected at least one session");

    const listed = await api.listSessions({ headers: current.headers });
    const listedTokens = listed.map((session) => session.token);
    const dbTokens = await getSessionTokensForUser(userId);

    expect(listedTokens).toHaveLength(2);
    expect(new Set(listedTokens)).toEqual(new Set(dbTokens));
    expect(new Set(listedTokens)).toEqual(new Set(sessions.map((session) => session.token)));
  });

  it("revokes a specific session token", async () => {
    const api = getSessionApi(requireContext());
    const { sessions, userId } = await createUserWithSessions(2);
    const current = sessions[0];
    const target = sessions[1];
    if (!current || !target) throw new Error("Expected two sessions");

    const result = await api.revokeSession({
      headers: current.headers,
      body: { token: target.token },
    });
    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens).toContain(current.token);
    expect(dbTokens).not.toContain(target.token);
  });

  it("revokes all sessions except the current one", async () => {
    const api = getSessionApi(requireContext());
    const { sessions, userId } = await createUserWithSessions(3);
    const current = sessions[2];
    if (!current) throw new Error("Expected current session");

    const result = await api.revokeOtherSessions({ headers: current.headers });
    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens[0]).toBe(current.token);
  });

  it("revokes all sessions for the current user", async () => {
    const api = getSessionApi(requireContext());
    const { sessions, userId } = await createUserWithSessions(2);
    const current = sessions[0];
    if (!current) throw new Error("Expected current session");

    const result = await api.revokeSessions({ headers: current.headers });
    expect(result.status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(0);
  });

  it("removes only the current session on sign out", async () => {
    const api = getSessionApi(requireContext());
    const { sessions, userId } = await createUserWithSessions(2);
    const current = sessions[0];
    const other = sessions[1];
    if (!current || !other) throw new Error("Expected two sessions");

    const result = await api.signOut({ headers: current.headers });
    expect((result as { success?: boolean; status?: boolean }).success ?? (result as { status?: boolean }).status).toBe(true);

    const dbTokens = await getSessionTokensForUser(userId);
    expect(dbTokens).toHaveLength(1);
    expect(dbTokens).not.toContain(current.token);
    expect(dbTokens).toContain(other.token);
  });
});
