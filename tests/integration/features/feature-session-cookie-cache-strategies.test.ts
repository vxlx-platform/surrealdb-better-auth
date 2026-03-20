import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import {
  getCookieCache,
  getCookies,
  parseCookies,
  setCookieToHeader,
} from "better-auth/cookies";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type CookieCacheStrategy = NonNullable<
  NonNullable<BetterAuthOptions["session"]>["cookieCache"]
>["strategy"];

const strategies = [
  { strategy: "compact", segmentCount: 1 },
  { strategy: "jwt", segmentCount: 3 },
  { strategy: "jwe", segmentCount: 5 },
] as const satisfies ReadonlyArray<{
  strategy: CookieCacheStrategy;
  segmentCount: number;
}>;

describe.each(strategies)(
  "Feature - Session Cookie Cache ($strategy)",
  ({ strategy, segmentCount }) => {
    let context: AuthContext | undefined;

    const requireContext = (): AuthContext => {
      if (!context) {
        throw new Error(`Live cookie-cache context was not initialized for "${strategy}".`);
      }
      return context;
    };

    beforeAll(async () => {
      context = await setupAuthContext({
        session: {
          cookieCache: {
            enabled: true,
            strategy,
            maxAge: 300,
          },
        },
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

    it("stores a decodable session cache cookie in the configured format", async () => {
      const ctx = requireContext();
      const email = `cookie-cache-${strategy}-${Date.now()}@example.com`;
      const password = "cookie-cache-password";

      const response = await ctx.auth.api.signUpEmail({
        body: {
          email,
          password,
          name: `Cookie Cache ${strategy}`,
        },
        asResponse: true,
      });

      const body = (await response.json()) as {
        user: { id: string; email: string };
      };

      const headers = new Headers();
      setCookieToHeader(headers)({ response });

      const authOptions = ctx.auth.options as BetterAuthOptions;
      const cookies = getCookies(authOptions);
      const cookieHeader = headers.get("cookie");
      expect(cookieHeader).toBeTruthy();

      const rawSessionData = parseCookies(cookieHeader!).get(cookies.sessionData.name);
      expect(rawSessionData).toBeTruthy();
      expect(rawSessionData?.split(".")).toHaveLength(segmentCount);

      const secret = authOptions.secret;
      if (typeof secret !== "string") {
        throw new Error("Expected auth secret to be a string in test context.");
      }

      const cookieCache = await getCookieCache(headers, {
        secret,
        strategy,
        cookieName: "session_data",
        cookiePrefix: authOptions.advanced?.cookiePrefix,
      });

      expect(cookieCache).not.toBeNull();
      expect(cookieCache?.user.id).toBe(body.user.id);
      expect(cookieCache?.user.email).toBe(email);
      expect(cookieCache?.session.token).toBeTypeOf("string");

      const session = await ctx.auth.api.getSession({ headers });
      expect(session?.user.id).toBe(body.user.id);
      expect(session?.user.email).toBe(email);
    });
  },
);
