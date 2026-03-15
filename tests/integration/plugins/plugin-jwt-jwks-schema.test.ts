import { jwt } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

describe("Plugin - JWT JWKS Schema", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("JWT JWKS schema context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [
        jwt({
          jwks: {
            jwksPath: "/.well-known/jwks.json",
          },
        }),
      ],
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

  it("adds jwks table schema when JWT plugin is configured", async () => {
    const authOptions = requireContext().auth.options as BetterAuthOptions;
    const schema = await requireContext().adapter.createSchema?.(
      authOptions,
      "plugin-jwt-jwks-schema.surql",
    );
    expect(schema?.code).toContain("DEFINE TABLE OVERWRITE jwks SCHEMAFULL;");
  });
});
