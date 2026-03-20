import type { BetterAuthOptions } from "better-auth";
import { setCookieToHeader } from "better-auth/cookies";
import { anonymous } from "better-auth/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type AnonymousUser = {
  id: string;
  email: string;
  name: string;
  isAnonymous?: boolean;
};

type SignInAnonymousResult = {
  token?: string;
  user: AnonymousUser;
};

type AnonymousApi = {
  signInAnonymous: (input?: { asResponse?: boolean; headers?: Headers }) => Promise<unknown>;
  deleteAnonymousUser: (input: {
    headers: Headers;
    asResponse?: boolean;
  }) => Promise<{ success: boolean } | Response>;
};

const asAnonymousApi = (value: unknown): AnonymousApi => value as AnonymousApi;

describe("Plugin - Anonymous", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live anonymous context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [anonymous()],
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

  it("adds the isAnonymous field to generated schema and live metadata", async () => {
    const context = requireContext();
    const authOptions = context.auth.options as BetterAuthOptions;
    const schema = await context.adapter.createSchema?.(authOptions, "anonymous-plugin-live.surql");

    expect(schema?.code).toMatch(/DEFINE FIELD(?: OVERWRITE)? isAnonymous ON TABLE user TYPE [^;]+;/);

    const tableInfo = await context.db.query("INFO FOR TABLE user;");
    const fields =
      ((tableInfo as Array<{ fields?: Record<string, string> }>)[0]?.fields as
        | Record<string, string>
        | undefined) ?? {};

    expect(fields.isAnonymous).toBeDefined();
    expect(fields.isAnonymous).toMatch(/DEFINE FIELD isAnonymous ON user TYPE (none \| )?bool\b/);
  });

  it("creates an anonymous user and session with the expected persisted field values", async () => {
    const context = requireContext();
    const api = asAnonymousApi(context.auth.api);

    const response = (await api.signInAnonymous({ asResponse: true })) as Response;
    expect(response.status).toBe(200);

    const body = (await response.json()) as SignInAnonymousResult;
    expect(body.token).toBeDefined();
    expect(body.user.id).toMatch(/^user:/);
    expect(body.user.name).toBe("Anonymous");
    expect(body.user.email).toMatch(/^temp@.+\.com$/);
    expect(body.user.isAnonymous).toBe(true);

    const dbUser = await context.adapter.findOne<AnonymousUser>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: body.user.id }],
    });
    expect(dbUser?.isAnonymous).toBe(true);
    expect(dbUser?.email).toBe(body.user.email);

    const sessions = await context.adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: body.user.id }],
    });
    expect(sessions).toHaveLength(1);
  });

  it("deletes the anonymous user and their session through the plugin endpoint", async () => {
    const context = requireContext();
    const api = asAnonymousApi(context.auth.api);

    const signInResponse = (await api.signInAnonymous({ asResponse: true })) as Response;
    expect(signInResponse.status).toBe(200);

    const body = (await signInResponse.json()) as SignInAnonymousResult;
    const headers = new Headers();
    setCookieToHeader(headers)({ response: signInResponse });

    const deleted = (await api.deleteAnonymousUser({ headers })) as { success: boolean };
    expect(deleted.success).toBe(true);

    const userAfterDelete = await context.adapter.findOne<AnonymousUser>({
      model: "user",
      where: [{ field: "id", operator: "eq", value: body.user.id }],
    });
    expect(userAfterDelete).toBeNull();

    const remainingSessions = await context.adapter.count({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: body.user.id }],
    });
    expect(remainingSessions).toBe(0);
  });

  it("applies custom email and name generation options to anonymous users", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        anonymous({
          emailDomainName: "guest.example.com",
          generateName: () => "Guest User",
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asAnonymousApi(customContext.auth.api);
      const response = (await api.signInAnonymous({ asResponse: true })) as Response;
      expect(response.status).toBe(200);

      const body = (await response.json()) as SignInAnonymousResult;
      expect(body.user.name).toBe("Guest User");
      expect(body.user.email).toMatch(/^temp-[a-z0-9]+@guest\.example\.com$/);
      expect(body.user.isAnonymous).toBe(true);

      const dbUser = await customContext.adapter.findOne<AnonymousUser>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: body.user.id }],
      });
      expect(dbUser?.name).toBe("Guest User");
      expect(dbUser?.email).toBe(body.user.email);
      expect(dbUser?.isAnonymous).toBe(true);
    } finally {
      await customContext.closeDb();
    }
  });

  it("rejects deleteAnonymousUser when delete disabling is enabled", async () => {
    const customContext = await setupAuthContext({
      plugins: [
        anonymous({
          disableDeleteAnonymousUser: true,
        }),
      ],
    });

    try {
      await customContext.reset();
      const api = asAnonymousApi(customContext.auth.api);
      const signInResponse = (await api.signInAnonymous({ asResponse: true })) as Response;
      expect(signInResponse.status).toBe(200);

      const body = (await signInResponse.json()) as SignInAnonymousResult;
      const headers = new Headers();
      setCookieToHeader(headers)({ response: signInResponse });

      const deleteResponse = (await api.deleteAnonymousUser({
        headers,
        asResponse: true,
      })) as Response;
      expect(deleteResponse.status).toBe(400);

      const payload = (await deleteResponse.json()) as Record<string, unknown>;
      expect(JSON.stringify(payload).toLowerCase()).toMatch(/disabled/);

      const persistedUser = await customContext.adapter.findOne<AnonymousUser>({
        model: "user",
        where: [{ field: "id", operator: "eq", value: body.user.id }],
      });
      expect(persistedUser?.isAnonymous).toBe(true);

      const sessionCount = await customContext.adapter.count({
        model: "session",
        where: [{ field: "userId", operator: "eq", value: body.user.id }],
      });
      expect(sessionCount).toBe(1);
    } finally {
      await customContext.closeDb();
    }
  });
});
