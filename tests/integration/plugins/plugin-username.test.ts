import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { username } from "better-auth/plugins";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { withSuppressedConsoleError } from "../../__helpers__/suppress-console-error";

type UsernameFields = {
  username?: string;
  displayUsername?: string;
};

type UserRow = {
  id: string;
  username?: string;
  displayUsername?: string;
};

type UsernameApi = {
  signUpEmail: (input: {
    body: {
      email: string;
      password: string;
      name: string;
      username: string;
      image?: string | undefined;
      callbackURL?: string | undefined;
      rememberMe?: boolean | undefined;
    };
  }) => Promise<{ user: { id: string; email: string } & UsernameFields }>;
  signInUsername: (input: {
    body: { username: string; password: string };
  }) => Promise<{ user: { id: string; email: string } }>;
  isUsernameAvailable: (input: {
    body: { username: string };
  }) => Promise<{ available: boolean }>;
};

const withUsernameFields = <T extends object>(user: T): T & UsernameFields =>
  user as T & UsernameFields;

const asUsernameApi = (api: unknown): UsernameApi => api as UsernameApi;

describe("Live DB - Username Plugin", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live username context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [username()],
    });
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  beforeEach(async () => {
    await requireContext().reset();
  });

  it("adds required username plugin fields to generated schema and live table metadata", async () => {
    const context = requireContext();
    const authOptions = context.auth.options as BetterAuthOptions;
    const schema = await context.adapter.createSchema?.(authOptions, "username-plugin-live.surql");

    expect(schema?.code).toBeDefined();
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? username ON TABLE user TYPE [^;]+;/,
    );
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? displayUsername ON TABLE user TYPE [^;]+;/,
    );

    const tableInfo = await context.db.query("INFO FOR TABLE user;");
    const fields =
      ((tableInfo as Array<{ fields?: Record<string, string> }>)[0]?.fields as
        | Record<string, string>
        | undefined) ?? {};
    const indexes =
      ((tableInfo as Array<{ indexes?: Record<string, string> }>)[0]?.indexes as
        | Record<string, string>
        | undefined) ?? {};

    expect(fields.username).toBeDefined();
    expect(fields.displayUsername).toBeDefined();
    expect(fields.username).toMatch(/DEFINE FIELD username ON user TYPE (none \| )?string\b/);
    expect(fields.displayUsername).toMatch(
      /DEFINE FIELD displayUsername ON user TYPE (none \| )?string\b/,
    );
    expect(indexes.userEmail_idx).toBeDefined();
    expect(indexes.userUsername_idx).toBeDefined();
  });

  it("normalizes username on sign-up and supports sign-in by username", async () => {
    const context = requireContext();
    const api = asUsernameApi(context.auth.api);
    const email = "live-username-signup@example.com";
    const password = "live-username-password";

    const signUp = await api.signUpEmail({
      body: {
        email,
        password,
        name: "Live Username User",
        username: "Live.User_Name",
      },
    });
    const signUpUser = withUsernameFields(signUp.user);

    expect(signUpUser.username).toBe("live.user_name");
    expect(signUpUser.displayUsername).toBe("Live.User_Name");

    const dbUser = await context.adapter.findOne<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: signUp.user.id }],
    });
    expect(dbUser?.username).toBe("live.user_name");
    expect(dbUser?.displayUsername).toBe("Live.User_Name");

    const signIn = await api.signInUsername({
      body: {
        username: "LIVE.USER_NAME",
        password,
      },
    });
    expect(signIn.user.id).toBe(signUp.user.id);
    expect(signIn.user.email).toBe(email);
  });

  it("returns accurate username availability before and after registration", async () => {
    const context = requireContext();
    const api = asUsernameApi(context.auth.api);

    const before = await api.isUsernameAvailable({
      body: { username: "availability_user" },
    });
    expect(before.available).toBe(true);

    await api.signUpEmail({
      body: {
        email: "live-availability@example.com",
        password: "live-availability-password",
        name: "Availability User",
        username: "availability_user",
      },
    });

    const after = await api.isUsernameAvailable({
      body: { username: "AVAILABILITY_USER" },
    });
    expect(after.available).toBe(false);
  });

  it("rejects duplicate usernames and wrong-password username sign-ins", async () => {
    const context = requireContext();
    const api = asUsernameApi(context.auth.api);

    await api.signUpEmail({
      body: {
        email: "live-duplicate-user-1@example.com",
        password: "duplicate-pass",
        name: "Duplicate One",
        username: "duplicate_user",
      },
    });

    await expect(
      api.signUpEmail({
        body: {
          email: "live-duplicate-user-2@example.com",
          password: "duplicate-pass",
          name: "Duplicate Two",
          username: "duplicate_user",
        },
      }),
    ).rejects.toThrow();

    await withSuppressedConsoleError(
      async () =>
        await expect(
          api.signInUsername({
            body: {
              username: "duplicate_user",
              password: "wrong-password",
            },
          }),
        ).rejects.toThrow(),
      /invalid password/i,
    );
  });

  it("rejects invalid username format", async () => {
    const context = requireContext();
    const api = asUsernameApi(context.auth.api);

    await expect(
      api.isUsernameAvailable({
        body: { username: "invalid username" },
      }),
    ).rejects.toThrow();
  });
});
