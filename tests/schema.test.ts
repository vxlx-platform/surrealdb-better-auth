import { describe, expect, it } from "vitest";
import type { BetterAuthDBSchema } from "better-auth";

import { generateSurqlSchema } from "../src/index";

describe("Adapter Schema Generation (createSchema)", () => {
  const getModelName = (name: string) => name;
  const getFieldName = (opts: { field: string }) => opts.field;

  it("generates correct SurQL for tables, fields, and indexes", async () => {
    // 1. Mock a standard Better Auth schema representation
    const mockSchema: BetterAuthDBSchema = {
      user: {
        modelName: "user",
        fields: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
          email: { type: "string", required: true, unique: true },
          emailVerified: { type: "boolean", required: true },
          createdAt: { type: "date", required: true },
          // Optional field
          role: { type: "string", required: false },
        },
      },
      session: {
        modelName: "session",
        fields: {
          id: { type: "string", required: true },
          token: { type: "string", required: true, unique: true },
          // Foreign key reference
          userId: {
            type: "string",
            required: true,
            references: { model: "user", field: "id" },
          },
        },
      },
    };

    // 2. Execute the standalone generateSurqlSchema method
    const result = await generateSurqlSchema({
      file: "test.surql",
      tables: mockSchema,
      getModelName,
      getFieldName,
    });

    expect(result).toBeDefined();
    const sql = result.code;

    /* ========================================================
     * A. Table Definitions
     * ======================================================== */
    expect(sql).toContain("DEFINE TABLE user SCHEMAFULL;");
    expect(sql).toContain("DEFINE TABLE session SCHEMAFULL;");

    /* ========================================================
     * B. Standard Field Types & Optionality
     * ======================================================== */
    // Required string
    expect(sql).toContain("DEFINE FIELD name ON user TYPE string;");
    // Required boolean
    expect(sql).toContain("DEFINE FIELD emailVerified ON user TYPE bool;");
    // Required date
    expect(sql).toContain("DEFINE FIELD createdAt ON user TYPE datetime;");
    // Optional fields should be wrapped in option<...>
    expect(sql).toContain("DEFINE FIELD role ON user TYPE option<string>;");

    /* ========================================================
     * C. Relational Links (Record Pointers)
     * ======================================================== */
    // The userId string should be cast to a record<user> pointer
    expect(sql).toContain("DEFINE FIELD userId ON session TYPE record<user>;");

    /* ========================================================
     * D. Unique & Relational Indexes
     * ======================================================== */
    // Unique index for the user's email
    expect(sql).toContain("DEFINE INDEX userEmail_idx ON user COLUMNS email UNIQUE;");
    // Unique index for the session token
    expect(sql).toContain("DEFINE INDEX sessionToken_idx ON session COLUMNS token UNIQUE;");
    // Standard index for relational lookups (userId)
    expect(sql).toContain("DEFINE INDEX userId_idx ON session COLUMNS userId;");

    /* ========================================================
     * E. Exclusions
     * ======================================================== */
    // The primary "id" field should NOT be defined as a standard column
    // because SurrealDB inherently manages the record ID.
    expect(sql).not.toContain("DEFINE FIELD id ON user");
    expect(sql).not.toContain("DEFINE FIELD id ON session");
  });

  it("throws an error if an unsupported array type is passed", async () => {
    const invalidSchema: BetterAuthDBSchema = {
      test: {
        modelName: "test",
        fields: {
          // Better Auth schemas represent arrays literally, but the adapter
          // throws if an array literal is passed instead of string representation like "string[]"
          tags: { type: ["string"] as any, required: true },
        },
      },
    };

    await expect(
      generateSurqlSchema({
        file: "",
        tables: invalidSchema,
        getModelName,
        getFieldName,
      }),
    ).rejects.toThrow(/Array type not supported/);
  });

  it("throws an error if an unsupported primitive field type is passed", async () => {
    const invalidSchema: BetterAuthDBSchema = {
      test: {
        modelName: "test",
        fields: {
          rating: { type: "float" as any, required: true },
        },
      },
    };

    await expect(
      generateSurqlSchema({
        file: "",
        tables: invalidSchema,
        getModelName,
        getFieldName,
      }),
    ).rejects.toThrow(/Unsupported field type/);
  });
});
