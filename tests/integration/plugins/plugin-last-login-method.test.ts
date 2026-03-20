import type { BetterAuthOptions } from "better-auth";
import { lastLoginMethod } from "better-auth/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type UserRow = {
  id: string;
  email: string;
  lastLoginMethod?: string | null;
};

const getSetCookies = (response: Response): string[] => {
  const responseHeaders = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = responseHeaders.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies;
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
};

const getCookieValue = (response: Response, name: string) => {
  for (const cookie of getSetCookies(response)) {
    const [pair] = cookie.split(";");
    if (!pair) continue;
    const prefix = `${name}=`;
    if (pair.startsWith(prefix)) {
      return decodeURIComponent(pair.slice(prefix.length));
    }
  }
  return null;
};

describe("Plugin - Last Login Method", () => {
  describe("cookie tracking", () => {
    let context: AuthContext | undefined;

    const requireContext = (): AuthContext => {
      if (!context) {
        throw new Error("Live last-login-method cookie context was not initialized.");
      }
      return context;
    };

    beforeAll(async () => {
      context = await setupAuthContext({
        plugins: [lastLoginMethod()],
      });
    });

    beforeEach(async () => {
      await requireContext().reset();
    });

    afterAll(async () => {
      if (context) {
        await context.closeDb();
      }
    });

    it("sets the last-login-method cookie for email sign-up and sign-in", async () => {
      const context = requireContext();
      const email = "last-login-cookie@example.com";
      const password = "last-login-cookie-password";

      const signUpResponse = await context.auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "Last Login Cookie User",
        },
        asResponse: true,
      });
      expect(signUpResponse.status).toBe(200);
      expect(getCookieValue(signUpResponse, "better-auth.last_used_login_method")).toBe("email");

      const signInResponse = await context.auth.api.signInEmail({
        body: {
          email,
          password,
        },
        asResponse: true,
      });
      expect(signInResponse.status).toBe(200);
      expect(getCookieValue(signInResponse, "better-auth.last_used_login_method")).toBe("email");
    });
  });

  describe("database persistence", () => {
    let context: AuthContext | undefined;

    const requireContext = (): AuthContext => {
      if (!context) {
        throw new Error("Live last-login-method database context was not initialized.");
      }
      return context;
    };

    beforeAll(async () => {
      context = await setupAuthContext({
        plugins: [
          lastLoginMethod({
            storeInDatabase: true,
          }),
        ],
      });
    });

    beforeEach(async () => {
      await requireContext().reset();
    });

    afterAll(async () => {
      if (context) {
        await context.closeDb();
      }
    });

    it("adds the lastLoginMethod field to generated schema and live metadata", async () => {
      const context = requireContext();
      const authOptions = context.auth.options as BetterAuthOptions;
      const schema = await context.adapter.createSchema?.(
        authOptions,
        "last-login-method-plugin-live.surql",
      );

      expect(schema?.code).toMatch(
        /DEFINE FIELD(?: OVERWRITE)? lastLoginMethod ON TABLE user TYPE [^;]+;/,
      );

      const tableInfo = await context.db.query("INFO FOR TABLE user;");
      const fields =
        ((tableInfo as Array<{ fields?: Record<string, string> }>)[0]?.fields as
          | Record<string, string>
          | undefined) ?? {};

      expect(fields.lastLoginMethod).toBeDefined();
      expect(fields.lastLoginMethod).toMatch(
        /DEFINE FIELD lastLoginMethod ON user TYPE (none \| )?string\b/,
      );
    });

    it("persists email as the lastLoginMethod on sign-up and sign-in", async () => {
      const context = requireContext();
      const email = "last-login-db@example.com";
      const password = "last-login-db-password";

      const signUp = await context.auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "Last Login Database User",
        },
      });

      const userAfterSignUp = await context.adapter.findOne<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: signUp.user.id }],
      });
      expect(userAfterSignUp?.lastLoginMethod).toBe("email");

      await context.adapter.update<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: signUp.user.id }],
        update: { lastLoginMethod: null },
      });

      const clearedUser = await context.adapter.findOne<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: signUp.user.id }],
      });
      expect(clearedUser?.lastLoginMethod ?? null).toBeNull();

      const signIn = await context.auth.api.signInEmail({
        body: {
          email,
          password,
        },
      });
      expect(signIn.user.id).toBe(signUp.user.id);

      const userAfterSignIn = await context.adapter.findOne<UserRow>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: signUp.user.id }],
      });
      expect(userAfterSignIn?.lastLoginMethod).toBe("email");
    });
  });
});
