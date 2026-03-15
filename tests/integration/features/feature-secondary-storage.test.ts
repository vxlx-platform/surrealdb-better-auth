import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setCookieToHeader } from "better-auth/cookies";
import type { BetterAuthOptions } from "better-auth";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type CacheEntry = {
  value: string;
  expiresAt: number | null;
};

const createInMemorySecondaryStorage = () => {
  const entries = new Map<string, CacheEntry>();

  const read = (key: string): string | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry.value;
  };

  return {
    get: async (key: string) => read(key),
    set: async (key: string, value: string, ttl?: number) => {
      const expiresAt = typeof ttl === "number" && ttl > 0 ? Date.now() + ttl * 1000 : null;
      entries.set(key, { value, expiresAt });
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    keys: () => {
      const now = Date.now();
      return [...entries.entries()]
        .filter(([, entry]) => entry.expiresAt === null || entry.expiresAt > now)
        .map(([key]) => key);
    },
  };
};

describe("Feature - Secondary Storage Sessions", () => {
  let context: AuthContext | undefined;
  const secondaryStorage = createInMemorySecondaryStorage();

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live secondary-storage context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      session: {
        storeSessionInDatabase: false,
      },
      secondaryStorage: secondaryStorage as unknown as BetterAuthOptions["secondaryStorage"],
    });

    const ctx = requireContext();
    const schema = await ctx.adapter.createSchema?.(
      ctx.auth.options as BetterAuthOptions,
      "secondary-storage.surql",
    );
    expect(schema?.code).toBeDefined();
    expect(schema?.code).not.toContain("DEFINE TABLE OVERWRITE session SCHEMAFULL;");
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE user SCHEMAFULL;");
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE account SCHEMAFULL;");
  });

  beforeEach(async () => {
    secondaryStorage.clear();
    await requireContext().reset();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("keeps session state in secondary storage without persisting session rows in SurrealDB", async () => {
    const ctx = requireContext();
    const email = `secondary-storage-${Date.now()}@example.com`;
    const password = "secondary-storage-password";

    const signUpResponse = await ctx.auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "Secondary Storage User",
      },
      asResponse: true,
    });
    const signUp = (await signUpResponse.json()) as {
      token: string;
      user: { id: string };
    };

    const signInResponse = await ctx.auth.api.signInEmail({
      body: {
        email,
        password,
      },
      asResponse: true,
    });
    const signIn = (await signInResponse.json()) as {
      token: string;
    };

    const headers = new Headers();
    setCookieToHeader(headers)({ response: signUpResponse });

    const listed = await ctx.auth.api.listSessions({ headers });
    const listedTokens = listed.map((session) => session.token);
    expect(listedTokens).toHaveLength(2);
    expect(new Set(listedTokens)).toEqual(new Set([signUp.token, signIn.token]));

    const secondaryKeys = secondaryStorage.keys();
    expect(secondaryKeys).toContain(signUp.token);
    expect(secondaryKeys).toContain(signIn.token);
    expect(secondaryKeys).toContain(`active-sessions-${signUp.user.id}`);

    let rawSessions: unknown[] = [];
    try {
      const queried = await ctx.db.query<unknown[] | [unknown[]]>("SELECT * FROM session;");
      const first = queried[0];
      rawSessions = Array.isArray(first) ? first : queried;
    } catch {
      rawSessions = [];
    }
    expect(rawSessions).toHaveLength(0);
  });
});
