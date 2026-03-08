import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import type { Surreal } from "surrealdb";

import { buildAdapter, ensureSchema, truncateAuthTables } from "./test-utils";

describe("email and password auth", () => {
  let db: Surreal;
  let auth: ReturnType<typeof betterAuth>;

  beforeAll(async () => {
    const built = await buildAdapter(
      { debugLogs: true },
      {
        emailAndPassword: {
          enabled: true,
        },
      },
    );
    db = built.db;
    auth = built.auth as typeof auth;
    await ensureSchema(db, built.adapter, built.builtConfig);
  });

  beforeEach(async () => {
    await truncateAuthTables(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("signs up a new user", async () => {
    const result = await auth.api.signUpEmail({
      body: {
        name: "John Doe",
        email: "john.doe@example.com",
        password: "password1234",
      },
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.user).toMatchObject({
      id: expect.any(String),
      name: "John Doe",
      email: "john.doe@example.com",
    });
  });

  it("signs in an existing user", async () => {
    await auth.api.signUpEmail({
      body: {
        name: "Jane Doe",
        email: "jane.doe@example.com",
        password: "password1234",
      },
    });

    const result = await auth.api.signInEmail({
      body: {
        email: "jane.doe@example.com",
        password: "password1234",
      },
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.user.email).toBe("jane.doe@example.com");
  });

  it("rejects sign in with the wrong password", async () => {
    await auth.api.signUpEmail({
      body: {
        name: "Bad Password User",
        email: "bad-password@example.com",
        password: "password1234",
      },
    });

    await expect(
      auth.api.signInEmail({
        body: {
          email: "bad-password@example.com",
          password: "wrong-password",
        },
      }),
    ).rejects.toThrow();
  });
});
