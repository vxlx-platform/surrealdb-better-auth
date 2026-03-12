import { describe, expect, it } from "vitest";

import { getScopedDbName } from "../__helpers__/env";
import { makeUserSeed } from "../__helpers__/factory";

describe("Unit - Test Helpers", () => {
  it("builds deterministic user seeds with required fields", () => {
    const seed = makeUserSeed();

    expect(seed.name).toEqual(expect.any(String));
    expect(seed.email).toContain("@example.com");
    expect(seed.createdAt).toBeInstanceOf(Date);
    expect(seed.updatedAt).toBeInstanceOf(Date);
  });

  it("scopes db names by worker only when isolation is enabled", () => {
    const prevIsolate = process.env.SURREALDB_TEST_ISOLATE;
    const prevPool = process.env.VITEST_POOL_ID;

    process.env.SURREALDB_TEST_ISOLATE = "0";
    process.env.VITEST_POOL_ID = "99";
    expect(getScopedDbName("main")).toBe("main");

    process.env.SURREALDB_TEST_ISOLATE = "1";
    expect(getScopedDbName("main")).toBe("main_99");

    process.env.SURREALDB_TEST_ISOLATE = prevIsolate;
    process.env.VITEST_POOL_ID = prevPool;
  });
});
