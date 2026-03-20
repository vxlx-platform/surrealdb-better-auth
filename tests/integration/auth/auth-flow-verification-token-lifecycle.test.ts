import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";
import { withSuppressedConsoleError } from "../../__helpers__/suppress-console-error";

const makeResetPasswordIdentifier = (token: string) => `reset-password:${token}`;

describe("Auth Flow - Verification Token Lifecycle", () => {
  let context: AuthContext | undefined;
  const resetTokens = new Map<string, string>();

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live verification context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({
          user,
          token,
        }: {
          user: { email: string };
          token: string;
        }) => {
          resetTokens.set(user.email.toLowerCase(), token);
        },
      },
    });
  });

  beforeEach(async () => {
    resetTokens.clear();
    await requireContext().reset();
  });

  afterAll(async () => {
    if (context) {
      await context.closeDb();
    }
  });

  it("creates, consumes, and invalidates reset-password verification tokens", async () => {
    const context = requireContext();
    const email = "reset-lifecycle@example.com";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword123!";

    const signedUp = await context.auth.api.signUpEmail({
      body: {
        name: "Reset Lifecycle User",
        email,
        password: oldPassword,
      },
    });

    const requested = await context.auth.api.requestPasswordReset({
      body: {
        email,
      },
    });
    expect(requested.status).toBe(true);

    const token = resetTokens.get(email.toLowerCase());
    expect(token).toBeDefined();
    if (!token) {
      throw new Error("Expected reset token to be generated.");
    }

    const identifier = makeResetPasswordIdentifier(token);

    const verificationBefore = await context.adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: identifier }],
    });
    expect(verificationBefore).not.toBeNull();
    expect(verificationBefore?.identifier).toBe(identifier);
    expect(verificationBefore?.value).toBe(signedUp.user.id);

    const reset = await context.auth.api.resetPassword({
      body: {
        token,
        newPassword,
      },
    });
    expect(reset.status).toBe(true);

    const verificationAfter = await context.adapter.findOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: identifier }],
    });
    expect(verificationAfter).toBeNull();

    await withSuppressedConsoleError(
      async () =>
        await expect(
          context.auth.api.signInEmail({
            body: {
              email,
              password: oldPassword,
            },
          }),
        ).rejects.toThrow(),
      /invalid password/i,
    );

    const signIn = await context.auth.api.signInEmail({
      body: {
        email,
        password: newPassword,
      },
    });
    expect(signIn.user.id).toBe(signedUp.user.id);
    expect(signIn.token).toBeDefined();

    await expect(
      context.auth.api.resetPassword({
        body: {
          token: token!,
          newPassword: "AnotherPassword123!",
        },
      }),
    ).rejects.toThrow();
  });

  it("does not create a token for unknown users while returning success", async () => {
    const context = requireContext();
    const unknownEmail = "unknown-reset@example.com";

    const requested = await withSuppressedConsoleError(
      async () =>
        await context.auth.api.requestPasswordReset({
          body: {
            email: unknownEmail,
          },
        }),
      /reset password:\s*user not found/i,
    );
    expect(requested.status).toBe(true);
    expect(resetTokens.get(unknownEmail.toLowerCase())).toBeUndefined();

    const verificationRows = await context.adapter.findMany<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "identifier", operator: "contains", value: "reset-password:" }],
    });
    expect(verificationRows).toHaveLength(0);
  });

});
