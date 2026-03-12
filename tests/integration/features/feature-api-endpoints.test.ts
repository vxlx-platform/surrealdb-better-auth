import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { Surreal } from "surrealdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getHttpApiBaseUrl, getSurrealHttpHeaders } from "../../__helpers__/env";
import { expectOkJson } from "../../__helpers__/http";
import { type TestServerHandle, startTestServer } from "../../__helpers__/server";
import { buildAdapter, ensureSchema, truncateAuthTables } from "../../test-utils";

describe("Feature - Generated DEFINE API Endpoints", () => {
  let db: Surreal;
  let adapter: DBAdapter;
  let apiBaseUrl: string;
  let headers: Record<string, string>;
  let server: TestServerHandle;

  beforeAll(async () => {
    const built = await buildAdapter({
      apiEndpoints: true,
    });

    db = built.db;
    adapter = built.adapter;
    apiBaseUrl = getHttpApiBaseUrl();
    headers = getSurrealHttpHeaders();

    await ensureSchema(db, adapter, built.builtConfig);
    server = await startTestServer();
  });

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await db.close();
  });

  it("serves the default /user endpoint from the live SurrealDB HTTP API", async () => {
    await adapter.create({
      model: "user",
      data: {
        name: "API User",
        email: "api-user@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await fetch(`${apiBaseUrl}/user`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    const body = (await expectOkJson(
      response,
      "SurrealDB default /user endpoint",
    )) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((row) => row.email === "api-user@example.com")).toBe(true);
  });

  it("serves a custom basePath endpoint from the live SurrealDB HTTP API", async () => {
    const built = await buildAdapter({
      apiEndpoints: {
        basePath: "/better-auth",
      },
    });

    await ensureSchema(built.db, built.adapter, built.builtConfig);

    await built.adapter.create({
      model: "user",
      data: {
        name: "Prefixed API User",
        email: "prefixed-api-user@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await fetch(`${apiBaseUrl}/better-auth/user`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    const body = (await expectOkJson(
      response,
      "SurrealDB custom /better-auth/user endpoint",
    )) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((row) => row.email === "prefixed-api-user@example.com")).toBe(true);

    await built.db.close();
  });
});
