import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { username } from "better-auth/plugins";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { startTestServer } from "../../__helpers__/server";
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
      displayUsername?: string | undefined;
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

  it("respects custom username length options", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        username({
          minUsernameLength: 5,
          maxUsernameLength: 8,
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asUsernameApi(customContext.auth.api);

      await expect(
        api.isUsernameAvailable({
          body: { username: "abcd" },
        }),
      ).rejects.toThrow();

      await expect(
        api.signUpEmail({
          body: {
            email: "length-too-long@example.com",
            password: "length-pass",
            name: "Length Too Long",
            username: "waytoolong",
          },
        }),
      ).rejects.toThrow();

      const valid = await api.signUpEmail({
        body: {
          email: "length-valid@example.com",
          password: "length-pass",
          name: "Length Valid",
          username: "lengthok",
        },
      });
      expect(withUsernameFields(valid.user).username).toBe("lengthok");
    } finally {
      await customContext.closeDb();
    }
  });

  it("applies custom username and display username normalization options", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        username({
          usernameNormalization: (value) =>
            value.toLowerCase().replaceAll("0", "o").replaceAll("3", "e"),
          displayUsernameNormalization: (value) => value.toLowerCase(),
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asUsernameApi(customContext.auth.api);

      const signUp = await api.signUpEmail({
        body: {
          email: "custom-normalization@example.com",
          password: "custom-normalization-password",
          name: "Normalization User",
          username: "C00L.Us3r",
          displayUsername: "Display_NAME",
        },
      });
      const user = withUsernameFields(signUp.user);

      expect(user.username).toBe("cool.user");
      expect(user.displayUsername).toBe("display_name");

      const dbUser = await customContext.adapter.findOne<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: signUp.user.id }],
      });
      expect(dbUser?.username).toBe("cool.user");
      expect(dbUser?.displayUsername).toBe("display_name");

      const signIn = await api.signInUsername({
        body: {
          username: "Cool.UsEr",
          password: "custom-normalization-password",
        },
      });
      expect(signIn.user.id).toBe(signUp.user.id);
    } finally {
      await customContext.closeDb();
    }
  });

  it("respects custom username and display username validators", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        username({
          usernameValidator: (value) => value !== "admin",
          displayUsernameValidator: (value) => /^[a-zA-Z0-9_-]+$/.test(value),
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asUsernameApi(customContext.auth.api);

      await expect(
        api.signUpEmail({
          body: {
            email: "reserved-username@example.com",
            password: "reserved-pass",
            name: "Reserved User",
            username: "admin",
          },
        }),
      ).rejects.toThrow();

      await expect(
        api.signUpEmail({
          body: {
            email: "invalid-display@example.com",
            password: "display-pass",
            name: "Display User",
            username: "valid_user",
            displayUsername: "Invalid Display!",
          },
        }),
      ).rejects.toThrow();

      const valid = await api.signUpEmail({
        body: {
          email: "valid-custom-validator@example.com",
          password: "validator-pass",
          name: "Valid Validator",
          username: "member_user",
          displayUsername: "Valid_Name",
        },
      });
      expect(withUsernameFields(valid.user).username).toBe("member_user");
      expect(withUsernameFields(valid.user).displayUsername).toBe("Valid_Name");
    } finally {
      await customContext.closeDb();
    }
  });

  it("supports post-normalization username validation", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        username({
          usernameNormalization: (value) => value.toLowerCase(),
          usernameValidator: (value) => /^[a-z]+$/.test(value),
          validationOrder: {
            username: "post-normalization",
          },
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asUsernameApi(customContext.auth.api);

      const signUp = await api.signUpEmail({
        body: {
          email: "post-normalization@example.com",
          password: "post-normalization-password",
          name: "Post Normalization",
          username: "CaseUser",
        },
      });

      const user = withUsernameFields(signUp.user);
      expect(user.username).toBe("caseuser");
      expect(user.displayUsername).toBe("CaseUser");
    } finally {
      await customContext.closeDb();
    }
  });

  it("supports disabling the username availability endpoint", async () => {
    const customContext = await setupAuthContext({
      disabledPaths: ["/is-username-available"],
      plugins: [username()],
    });
    const server = await startTestServer(customContext.auth);

    try {
      await customContext.reset();

      const response = await fetch(server.url("/api/auth/is-username-available"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "hidden_user" }),
        signal: AbortSignal.timeout(5_000),
      });

      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      await customContext.closeDb();
    }
  });
});
