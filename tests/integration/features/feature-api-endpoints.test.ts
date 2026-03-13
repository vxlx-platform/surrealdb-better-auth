import type { DBAdapter } from "@better-auth/core/db/adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestServerHandle } from "../../__helpers__/server";

import { getHttpApiBaseUrl, getSurrealHttpHeaders } from "../../__helpers__/env";
import { expectOkJson, fetchWithTimeout } from "../../__helpers__/http";
import { startTestServer } from "../../__helpers__/server";
import { setupIntegrationAdapter } from "../../test-utils";

describe("Feature - Generated DEFINE API Endpoints", () => {
  let adapter: DBAdapter;
  let apiBaseUrl: string;
  let headers: Record<string, string>;
  let server: TestServerHandle;
  let resetDb: () => Promise<void>;
  let closeDb: () => Promise<true>;

  beforeAll(async () => {
    const built = await setupIntegrationAdapter({
      apiEndpoints: true,
    });

    adapter = built.adapter;
    apiBaseUrl = getHttpApiBaseUrl();
    headers = getSurrealHttpHeaders();
    resetDb = built.reset;
    closeDb = built.close;

    server = await startTestServer();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await closeDb();
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

    const response = await fetchWithTimeout(`${apiBaseUrl}/user`, {
      headers,
    });

    const body = (await expectOkJson(response, "SurrealDB default /user endpoint")) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((row) => row.email === "api-user@example.com")).toBe(true);
  });

  it("serves a custom basePath endpoint from the live SurrealDB HTTP API", async () => {
    const built = await setupIntegrationAdapter({
      apiEndpoints: {
        basePath: "/better-auth",
      },
    });

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

    const response = await fetchWithTimeout(`${apiBaseUrl}/better-auth/user`, {
      headers,
    });

    const body = (await expectOkJson(
      response,
      "SurrealDB custom /better-auth/user endpoint",
    )) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((row) => row.email === "prefixed-api-user@example.com")).toBe(true);

    await built.close();
  });
});
