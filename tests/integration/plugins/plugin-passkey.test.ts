import type { BetterAuthOptions } from "better-auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { passkey } from "@better-auth/passkey";

import { setupAuthContext } from "../../__helpers__/auth-context";
import type { AuthContext } from "../../__helpers__/auth-context";

type PasskeyRow = {
  id: string;
  userId: string;
  name?: string | null;
  publicKey: string;
  credentialID: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports?: string | null;
  createdAt?: Date | null;
  aaguid?: string | null;
};

type PasskeyApi = {
  listPasskeys: (input: {
    headers?: Headers;
    asResponse?: boolean;
  }) => Promise<PasskeyRow[] | Response>;
  updatePasskey: (input: {
    headers?: Headers;
    body: {
      id: string;
      name: string;
    };
    asResponse?: boolean;
  }) => Promise<{ passkey: PasskeyRow } | Response>;
  deletePasskey: (input: {
    headers?: Headers;
    body: {
      id: string;
    };
    asResponse?: boolean;
  }) => Promise<{ status: boolean } | Response>;
};

const asPasskeyApi = (value: unknown): PasskeyApi => value as PasskeyApi;

const createUserWithHeaders = async (context: AuthContext, email: string) => {
  const draftUser = await context.test.createUser({
    email,
    password: "passkey-plugin-password",
    name: "Passkey Plugin User",
  });

  const user = await context.test.saveUser(draftUser);

  const headers = await context.test.getAuthHeaders({ userId: user.id });
  return { user, headers };
};

const createPasskeyRow = async (
  context: AuthContext,
  input: {
    userId: string;
    name?: string;
    credentialID: string;
  }
) =>
  await context.adapter.create<PasskeyRow>({
    model: "passkey",
    data: {
      name: input.name,
      userId: input.userId,
      publicKey: "mock-public-key",
      credentialID: input.credentialID,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: "internal,hybrid",
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
      aaguid: "00000000-0000-0000-0000-000000000000",
    },
  });

describe("Plugin - Passkey", () => {
  let context: AuthContext | undefined;

  const requireContext = (): AuthContext => {
    if (!context) {
      throw new Error("Live passkey context was not initialized.");
    }
    return context;
  };

  beforeAll(async () => {
    context = await setupAuthContext({
      plugins: [passkey()],
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

  it("adds the passkey table and fields to generated schema and live metadata", async () => {
    const context = requireContext();
    const authOptions = context.auth.options as BetterAuthOptions;
    const schema = await context.adapter.createSchema?.(
      authOptions,
      "passkey-plugin-live.surql"
    );

    expect(schema?.code).toMatch(
      /DEFINE TABLE(?: OVERWRITE)? passkey SCHEMAFULL;/
    );
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? userId ON TABLE passkey TYPE [^;]+ REFERENCE ON DELETE CASCADE;/
    );
    expect(schema?.code).toMatch(
      /DEFINE FIELD(?: OVERWRITE)? credentialID ON TABLE passkey TYPE [^;]+;/
    );
    expect(schema?.code).toMatch(
      /DEFINE INDEX(?: OVERWRITE)? `?passkeyUserId_idx`? ON TABLE passkey COLUMNS userId;/
    );
    expect(schema?.code).toMatch(
      /DEFINE INDEX(?: OVERWRITE)? `?passkeyCredentialID_idx`? ON TABLE passkey COLUMNS credentialID;/
    );

    const tableInfo = await context.db.query("INFO FOR TABLE passkey;");
    const fields =
      ((tableInfo as Array<{ fields?: Record<string, string> }>)[0]?.fields as
        | Record<string, string>
        | undefined) ?? {};

    expect(fields.userId).toMatch(
      /DEFINE FIELD userId ON passkey TYPE (none \| )?record<user> REFERENCE ON DELETE CASCADE/
    );
    expect(fields.credentialID).toMatch(
      /DEFINE FIELD credentialID ON passkey TYPE (none \| )?string\b/
    );
  });

  it("lists only the authenticated user's passkeys", async () => {
    const context = requireContext();
    const api = asPasskeyApi(context.auth.api);
    const owner = await createUserWithHeaders(
      context,
      "passkey-owner@example.com"
    );
    const other = await createUserWithHeaders(
      context,
      "passkey-other@example.com"
    );

    const ownedA = await createPasskeyRow(context, {
      userId: owner.user.id,
      name: "Laptop Passkey",
      credentialID: "cred-owner-a",
    });
    const ownedB = await createPasskeyRow(context, {
      userId: owner.user.id,
      name: "Phone Passkey",
      credentialID: "cred-owner-b",
    });
    await createPasskeyRow(context, {
      userId: other.user.id,
      name: "Other User Passkey",
      credentialID: "cred-other-a",
    });

    const listed = (await api.listPasskeys({
      headers: owner.headers,
    })) as PasskeyRow[];

    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.id).sort()).toEqual(
      [ownedA.id, ownedB.id].sort()
    );
    expect(listed.every((row) => row.userId === owner.user.id)).toBe(true);
  });

  it("updates and deletes an owned passkey through the plugin endpoints", async () => {
    const context = requireContext();
    const api = asPasskeyApi(context.auth.api);
    const owner = await createUserWithHeaders(
      context,
      "passkey-update-owner@example.com"
    );
    const row = await createPasskeyRow(context, {
      userId: owner.user.id,
      name: "Initial Passkey Name",
      credentialID: "cred-update-owned",
    });

    const updated = (await api.updatePasskey({
      headers: owner.headers,
      body: {
        id: row.id,
        name: "Renamed Passkey",
      },
    })) as { passkey: PasskeyRow };
    expect(updated.passkey.id).toBe(row.id);
    expect(updated.passkey.name).toBe("Renamed Passkey");

    const persistedAfterUpdate = await context.adapter.findOne<PasskeyRow>({
      model: "passkey",
      where: [{ field: "id", operator: "eq", value: row.id }],
    });
    expect(persistedAfterUpdate?.name).toBe("Renamed Passkey");

    const deleted = (await api.deletePasskey({
      headers: owner.headers,
      body: {
        id: row.id,
      },
    })) as { status: boolean };
    expect(deleted.status).toBe(true);

    const persistedAfterDelete = await context.adapter.findOne<PasskeyRow>({
      model: "passkey",
      where: [{ field: "id", operator: "eq", value: row.id }],
    });
    expect(persistedAfterDelete).toBeNull();
  });

  it("rejects updating or deleting another user's passkey", async () => {
    const context = requireContext();
    const api = asPasskeyApi(context.auth.api);
    const owner = await createUserWithHeaders(
      context,
      "passkey-forbidden-owner@example.com"
    );
    const other = await createUserWithHeaders(
      context,
      "passkey-forbidden-other@example.com"
    );
    const row = await createPasskeyRow(context, {
      userId: owner.user.id,
      name: "Protected Passkey",
      credentialID: "cred-protected",
    });

    const updateResponse = (await api.updatePasskey({
      headers: other.headers,
      body: {
        id: row.id,
        name: "Hacked Name",
      },
      asResponse: true,
    })) as Response;
    expect(updateResponse.status).toBe(401);

    const deleteResponse = (await api.deletePasskey({
      headers: other.headers,
      body: {
        id: row.id,
      },
      asResponse: true,
    })) as Response;
    expect(deleteResponse.status).toBe(401);

    const persisted = await context.adapter.findOne<PasskeyRow>({
      model: "passkey",
      where: [{ field: "id", operator: "eq", value: row.id }],
    });
    expect(persisted?.name).toBe("Protected Passkey");
  });
});
