import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import type { BetterAuthDBSchema } from "better-auth";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { surrealAdapter } from "../src";
import { createTestDb } from "./test-db";

describe("surrealdb-adapter plugins", async () => {
  it("should generate schema including plugin fields like username", async () => {
    const { db } = await createTestDb();

    // 1. Initialize auth with the username plugin to build the schema
    const auth = betterAuth({
      database: surrealAdapter(db),
      plugins: [username()],
    });

    // 2. Auth Options now holds the fully merged schema including plugin fields
    // We cast using the defined internal type mappings from better-auth core
    const builtConfig = auth.options as BetterAuthOptions;

    // BetterAuth compiles plugins and attaches them onto `opts.plugins`
    // which eventually end up in the schema object, but during build they
    // construct `auth.options.database` as a DBAdapterInstance callable block.
    // By passing an empty init config to it, we get back the instantiated Adapter.
    const adapterFactory = builtConfig.database as DBAdapterInstance;
    const instance = adapterFactory({
      plugins: builtConfig.plugins,
    });

    type BetterAuthOptionsWithHooks = BetterAuthOptions & {
      databaseHooks?: { getSchema?: () => BetterAuthDBSchema };
      schema?: BetterAuthDBSchema;
    };

    // Cast the createSchema function explicitly instead of `any`
    // The inner adapter exposes this function directly taking tables + file name.
    const createSchemaFn = instance.createSchema as (config: {
      file: string;
      tables: BetterAuthDBSchema;
    }) => Promise<{ code: string }>;

    const schemaResult = await createSchemaFn({
      file: "test.surql",
      // BetterAuth has internal mechanisms that hook schema together,
      // but passing it plugins here gives us the context we need
      tables:
        (builtConfig as BetterAuthOptionsWithHooks).databaseHooks?.getSchema?.() ||
        (builtConfig as BetterAuthOptionsWithHooks).schema ||
        {},
    });

    const generatedCode = schemaResult?.code || "";

    // Check if the username plugin field and matching unique index were generated
    // dynamically into the SurrealDB surreal schema definition
    expect(generatedCode).toContain("DEFINE FIELD username ON user TYPE option<string>;");
    expect(generatedCode).toContain(
      "DEFINE INDEX userUsername_idx ON user COLUMNS username UNIQUE;",
    );
  });
});
