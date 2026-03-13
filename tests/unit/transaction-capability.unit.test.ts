import type { DBAdapter, DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { Features, Surreal, UnsupportedFeatureError } from "surrealdb";

import { surrealAdapter } from "../../src";

type SurrealLike = {
  query: Surreal["query"];
  forkSession?: () => Promise<unknown>;
  isFeatureSupported?: (feature: unknown) => boolean;
};

const TEST_SECRET = "unit-test-secret-that-is-at-least-thirty-two-characters";

type SurrealAdapterConfig = NonNullable<Parameters<typeof surrealAdapter>[1]>;

const buildAdapter = (db: SurrealLike, config?: SurrealAdapterConfig): DBAdapter => {
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: TEST_SECRET,
    emailAndPassword: {
      enabled: true,
    },
    database: surrealAdapter(db as unknown as Surreal, config),
  });

  const builtConfig = auth.options as BetterAuthOptions;
  const adapterFactory = builtConfig.database as DBAdapterInstance;
  return adapterFactory(builtConfig) as DBAdapter;
};

describe("Unit - Transaction Capability Detection", () => {
  it("auto-disables transactions when SDK feature flags report sessions unsupported", async () => {
    const forkSession = vi.fn(async () => ({ closeSession: vi.fn(async () => {}) }));
    const isFeatureSupported = vi.fn((feature: unknown) => {
      if (feature === Features.Sessions || feature === Features.Transactions) {
        return false;
      }
      return true;
    });

    const adapter = buildAdapter(
      {
        query: vi.fn(async () => [] as unknown[]) as unknown as Surreal["query"],
        forkSession,
        isFeatureSupported,
      },
      { transaction: "auto" },
    );

    expect(adapter.options?.adapterConfig.transaction).toBe(false);

    await expect(adapter.transaction(async () => "ok")).resolves.toBe("ok");
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("falls back at runtime when forkSession exists but throws unsupported sessions", async () => {
    const forkSession = vi.fn(async () => {
      throw new UnsupportedFeatureError(Features.Sessions);
    });
    const query = vi.fn(async () => [[{ count: 0 }]]);

    const adapter = buildAdapter(
      {
        query: query as unknown as Surreal["query"],
        forkSession,
      },
      { transaction: "auto" },
    );

    await expect(
      adapter.transaction(async (trx) => trx.count({ model: "user" })),
    ).resolves.toBe(0);
    await expect(
      adapter.transaction(async (trx) => trx.count({ model: "user" })),
    ).resolves.toBe(0);

    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("throws when transactions are explicitly enabled but sessions are unsupported", async () => {
    const forkSession = vi.fn(async () => {
      throw new UnsupportedFeatureError(Features.Sessions);
    });

    const adapter = buildAdapter(
      {
        query: vi.fn(async () => [] as unknown[]) as unknown as Surreal["query"],
        forkSession,
      },
      { transaction: true },
    );

    await expect(adapter.transaction(async () => "never")).rejects.toThrow(
      /Failed to initialize a SurrealDB transaction session/,
    );
    expect(forkSession).toHaveBeenCalledTimes(1);
  });
});
