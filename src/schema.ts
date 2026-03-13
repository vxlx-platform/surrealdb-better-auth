import type { BetterAuthDBSchema, BetterAuthOptions } from "better-auth";
import { escapeIdent } from "surrealdb";
import type { Surreal } from "surrealdb";

type ModelNameResolver = (model: string) => string;
type FieldNameResolver = (input: { field: string; model: string }) => string;

/**
 * Optional config for generating SurrealDB DEFINE API endpoints from schema models.
 */
export interface SchemaApiEndpointsConfig {
  basePath?: string;
  models?: string[];
}

/**
 * Arguments for the standalone SurQL schema generator.
 */
export interface GenerateSurqlSchemaOptions {
  file?: string;
  tables?: BetterAuthDBSchema;
  getModelName: ModelNameResolver;
  getFieldName: FieldNameResolver;
  apiEndpoints?: boolean | SchemaApiEndpointsConfig;
}

export interface ApplySurqlSchemaOptions {
  db: Surreal;
  authOptions: BetterAuthOptions;
  file?: string;
}

const splitSurqlStatements = (code: string): string[] =>
  code
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);

export const executeSurqlSchema = async (db: Surreal, code: string) => {
  for (const statement of splitSurqlStatements(code)) {
    try {
      await db.query(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) {
        throw error;
      }
    }
  }
};

/**
 * Returns a SurQL schema string based on the provided Better Auth schema.
 */
export const generateSurqlSchema = async (options: GenerateSurqlSchemaOptions) => {
  const { file, tables, getModelName, getFieldName, apiEndpoints } = options;
  const code: string[] = [];
  const apiTableNames: string[] = [];
  const resolvedApiConfig =
    apiEndpoints === true
      ? {}
      : apiEndpoints && typeof apiEndpoints === "object"
        ? apiEndpoints
        : null;
  const apiBasePath = (() => {
    const raw = resolvedApiConfig?.basePath?.trim() || "";
    const trimmed = raw.replace(/^\/+|\/+$/g, "");
    return trimmed ? `/${trimmed}` : "";
  })();
  const apiModels = new Set(
    resolvedApiConfig?.models?.length
      ? resolvedApiConfig.models
      : ["user", "session", "account", "jwks"],
  );

  for (const tableKey in tables) {
    const table = tables[tableKey];
    if (!table) continue;

    const tableName = escapeIdent(getModelName(table.modelName));
    const rawTableName = getModelName(table.modelName);
    code.push(`DEFINE TABLE ${tableName} SCHEMAFULL;`);

    if (resolvedApiConfig && apiModels.has(table.modelName)) {
      apiTableNames.push(rawTableName);
    }

    for (const fieldKey in table.fields) {
      const field = table.fields[fieldKey];
      if (!field) continue;

      const dbFieldName = field.fieldName || fieldKey;
      if (dbFieldName === "id") continue;

      const fieldName = escapeIdent(getFieldName({ field: dbFieldName, model: table.modelName }));

      if (Array.isArray(field.type)) {
        throw new Error(`Array type not supported: ${JSON.stringify(field.type)}`);
      }

      const primitiveType = (
        {
          string: "string",
          number: "number",
          boolean: "bool",
          date: "datetime",
          "number[]": "array<number>",
          "string[]": "array<string>",
        } as Record<string, string>
      )[field.type as string];

      let type = primitiveType;

      if (field.references) {
        type = `record<${escapeIdent(getModelName(field.references.model))}>`;
      } else if (!type) {
        throw new Error(
          `Unsupported field type "${String(field.type)}" for ${table.modelName}.${dbFieldName}`,
        );
      }

      if (!field.required) {
        type = `option<${type}>`;
      }

      code.push(`DEFINE FIELD ${fieldName} ON ${tableName} TYPE ${type};`);

      if (field.unique) {
        const base = tableName.replace(/`/g, "");
        const col = fieldName.replace(/`/g, "");
        const idxName = `${base}${col.charAt(0).toUpperCase()}${col.slice(1)}_idx`;
        code.push(
          `DEFINE INDEX ${escapeIdent(idxName)} ON ${tableName} COLUMNS ${fieldName} UNIQUE;`,
        );
      } else if (field.references || fieldKey.toLowerCase().includes("id")) {
        code.push(
          `DEFINE INDEX ${escapeIdent(`${fieldName.replace(/`/g, "")}_idx`)} ON ${tableName} COLUMNS ${fieldName};`,
        );
      }
    }

    code.push("");
  }

  if (resolvedApiConfig) {
    for (const tableName of apiTableNames) {
      const path = `${apiBasePath}/${tableName}`;
      const escapedTable = escapeIdent(tableName);
      code.push(`DEFINE API OVERWRITE "${path}"`);
      code.push("  FOR get");
      code.push("  MIDDLEWARE");
      code.push('    api::res::body("json")');
      code.push("  THEN {");
      code.push("    {");
      code.push("      status: 200,");
      code.push(`      body: SELECT * FROM ${escapedTable}`);
      code.push("    }");
      code.push("  }");
      code.push(";");
      code.push("");
    }
  }

  const suggested = file ? file.replace(/\.[^/.]+$/, ".surql") : ".better-auth/schema.surql";

  return { code: code.join("\n"), path: suggested };
};

/**
 * Generates SurQL from a Better Auth configuration and applies it to the active
 * SurrealDB connection.
 */
export const applySurqlSchema = async ({ db, authOptions, file }: ApplySurqlSchemaOptions) => {
  const adapterFactory = authOptions.database as unknown as (input: {
    plugins?: BetterAuthOptions["plugins"];
  }) => {
    createSchema?: (
      options: BetterAuthOptions,
      file?: string,
    ) => Promise<{ code: string; path: string }>;
  };

  const adapter = adapterFactory({
    plugins: authOptions.plugins,
  });

  if (!adapter.createSchema) {
    throw new Error("The configured Better Auth adapter does not implement createSchema().");
  }

  const result = await adapter.createSchema(authOptions, file);
  if (result.code.trim()) {
    await executeSurqlSchema(db, result.code);
  }

  return result;
};
