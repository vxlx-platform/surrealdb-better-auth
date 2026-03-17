import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { BoundQuery, DateTime, RecordId } from "surrealdb";
import { describe, expect, it, vi } from "vitest";

import { surrealAdapter } from "../../src";

type MockTransaction = {
  query: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  beginTransaction?: ReturnType<typeof vi.fn>;
  isFeatureSupported?: ReturnType<typeof vi.fn>;
};

const createAdapter = (
  client: MockClient,
  config?: Parameters<typeof surrealAdapter>[1],
) => {
  const auth = betterAuth({
    baseURL: "http://127.0.0.1:3000",
    secret: "01234567890123456789012345678901",
    database: surrealAdapter(client as never, config),
  });

  const options = auth.options as BetterAuthOptions;
  const factory = options.database as DBAdapterInstance;
  return factory(options);
};

const createdUserRow = () => ({
  id: new RecordId("user", "tx-user"),
  email: "tx@example.com",
  name: "Tx User",
  emailVerified: false,
  createdAt: new DateTime("2026-03-13T12:00:00.000Z"),
  updatedAt: new DateTime("2026-03-13T12:00:00.000Z"),
});

const createUserData = () => ({
  email: "tx@example.com",
  name: "Tx User",
  emailVerified: false,
});

const canonicalUserId = new RecordId("user", "tx-user").toString();

const createMockCreateQuery = () => {
  let data: unknown;
  return {
    content(value: unknown) {
      data = value;
      return this;
    },
    output() {
      return this;
    },
    compile() {
      return new BoundQuery("CREATE ONLY user CONTENT $data RETURN AFTER;", { data });
    },
  };
};

const createMockCreate = () => vi.fn(() => createMockCreateQuery());

const createMockTransaction = (): MockTransaction => ({
  query: vi.fn().mockResolvedValue([[createdUserRow()]]),
  create: createMockCreate(),
  commit: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
});

describe("Adapter Core - Transactions", () => {
  it("commits the transaction when callback succeeds", async () => {
    const tx = createMockTransaction();
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    const created = await adapter.transaction(async (trx) => {
      return await trx.create<Record<string, unknown>>({
        model: "user",
        data: createUserData(),
      });
    });

    expect(created.id).toBe(canonicalUserId);
    expect(client.beginTransaction).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(tx.commit).toHaveBeenCalledTimes(1);
    expect(tx.cancel).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rolls back when callback throws", async () => {
    const tx = createMockTransaction();
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    await expect(
      adapter.transaction(async (trx) => {
        await trx.create<Record<string, unknown>>({
          model: "user",
          data: createUserData(),
        });
        throw new Error("rollback this transaction");
      }),
    ).rejects.toThrow("rollback this transaction");

    expect(tx.commit).not.toHaveBeenCalled();
    expect(tx.cancel).toHaveBeenCalledTimes(1);
  });

  it("rolls back when a query inside transaction fails", async () => {
    const tx = createMockTransaction();
    tx.query.mockRejectedValueOnce(new Error("write failed"));

    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    await expect(
      adapter.transaction(async (trx) => {
        await trx.create<Record<string, unknown>>({
          model: "user",
          data: createUserData(),
        });
      }),
    ).rejects.toThrow("write failed");

    expect(tx.commit).not.toHaveBeenCalled();
    expect(tx.cancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to non-transaction path when feature support is disabled", async () => {
    const client = {
      query: vi.fn().mockResolvedValue([[createdUserRow()]]),
      create: createMockCreate(),
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => false),
    } satisfies MockClient;
    const adapter = createAdapter(client);

    expect(adapter.options?.adapterConfig.transaction).toBe(false);

    const created = await adapter.transaction(async (trx) => {
      return await trx.create<Record<string, unknown>>({
        model: "user",
        data: createUserData(),
      });
    });

    expect(created.id).toBe(canonicalUserId);
    expect(client.beginTransaction).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("can be force-disabled even when feature support is reported as true", async () => {
    const client = {
      query: vi.fn().mockResolvedValue([[createdUserRow()]]),
      create: createMockCreate(),
      beginTransaction: vi.fn(),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: false });

    expect(adapter.options?.adapterConfig.transaction).toBe(false);

    await adapter.transaction(async (trx) => {
      await trx.create<Record<string, unknown>>({
        model: "user",
        data: createUserData(),
      });
    });

    expect(client.beginTransaction).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("propagates beginTransaction failures without invoking callback", async () => {
    const callback = vi.fn(async () => "ok");
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockRejectedValue(new Error("init tx failed")),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    await expect(adapter.transaction(callback)).rejects.toThrow("init tx failed");
    expect(callback).not.toHaveBeenCalled();
  });

  it("attempts cancel when commit fails and rethrows the commit failure", async () => {
    const tx = createMockTransaction();
    tx.commit.mockRejectedValueOnce(new Error("commit failed"));
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    await expect(
      adapter.transaction(async (trx) => {
        await trx.create<Record<string, unknown>>({
          model: "user",
          data: createUserData(),
        });
      }),
    ).rejects.toThrow("commit failed");

    expect(tx.cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves the original callback failure when cancel also fails", async () => {
    const tx = createMockTransaction();
    tx.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    await expect(
      adapter.transaction(async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(tx.commit).not.toHaveBeenCalled();
    expect(tx.cancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to non-transaction path when beginTransaction is unavailable", async () => {
    const client = {
      query: vi.fn().mockResolvedValue([[createdUserRow()]]),
      create: createMockCreate(),
      isFeatureSupported: vi.fn(() => true),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    expect(adapter.options?.adapterConfig.transaction).toBe(false);

    const created = await adapter.transaction(async (trx) => {
      return await trx.create<Record<string, unknown>>({
        model: "user",
        data: createUserData(),
      });
    });

    expect(created.id).toBe(canonicalUserId);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("enables transactions when beginTransaction exists and feature probing is unavailable", async () => {
    const tx = createMockTransaction();
    const client = {
      query: vi.fn(),
      create: createMockCreate(),
      beginTransaction: vi.fn().mockResolvedValue(tx),
    } satisfies MockClient;
    const adapter = createAdapter(client, { transaction: true });

    expect(adapter.options?.adapterConfig.transaction).not.toBe(false);

    await adapter.transaction(async (trx) => {
      await trx.create<Record<string, unknown>>({
        model: "user",
        data: createUserData(),
      });
    });

    expect(client.beginTransaction).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(tx.commit).toHaveBeenCalledTimes(1);
    expect(client.query).not.toHaveBeenCalled();
  });
});
