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
    .filter((statement) => statement.trim())
    .map((statement) => `${statement.trim()};`);

export const executeSurqlSchema = async (db: Surreal, code: string) => {
  for (const statement of splitSurqlStatements(code)) {
    try {
      await db.query(statement);
    } catch (error) {
      if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
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
  const apiCfg = apiEndpoints === true ? {} : apiEndpoints && typeof apiEndpoints === "object" ? apiEndpoints : null;
  const apiBasePath = apiCfg?.basePath ? `/${apiCfg.basePath.replace(/^\/+|\/+$/g, "")}` : "";
  const apiModels = new Set(apiCfg?.models?.length ? apiCfg.models : ["user", "session", "account", "jwks"]);

  for (const table of Object.values(tables || {}).filter(Boolean)) {
    const rawTableName = getModelName(table.modelName);
    const tableName = escapeIdent(rawTableName);
    code.push(`DEFINE TABLE ${tableName} SCHEMAFULL;`);

    if (apiCfg && apiModels.has(table.modelName)) apiTableNames.push(rawTableName);

    for (const [fieldKey, field] of Object.entries(table.fields).filter(([_, f]) => f)) {
      const dbFieldName = field.fieldName || fieldKey;
      if (dbFieldName === "id") continue;

      const fieldName = escapeIdent(getFieldName({ field: dbFieldName, model: table.modelName }));
      if (Array.isArray(field.type)) throw new Error(`Array type not supported: ${JSON.stringify(field.type)}`);

      const primitiveTypes: Record<string, string> = {
        string: "string",
        number: "number",
        boolean: "bool",
        date: "datetime",
        "number[]": "array<number>",
        "string[]": "array<string>",
      };

      let type = field.references
        ? `record<${escapeIdent(getModelName(field.references.model))}>`
        : primitiveTypes[field.type as string];

      if (!type) throw new Error(`Unsupported field type "${String(field.type)}" for ${table.modelName}.${dbFieldName}`);
      if (!field.required) type = `option<${type}>`;

      code.push(`DEFINE FIELD ${fieldName} ON ${tableName} TYPE ${type};`);

      if (field.unique) {
        const base = tableName.replace(/`/g, ""),
          col = fieldName.replace(/`/g, "");
        const idxName = `${base}${col.charAt(0).toUpperCase()}${col.slice(1)}_idx`;
        code.push(`DEFINE INDEX ${escapeIdent(idxName)} ON ${tableName} COLUMNS ${fieldName} UNIQUE;`);
      } else if (field.references || fieldKey.toLowerCase().includes("id")) {
        code.push(`DEFINE INDEX ${escapeIdent(`${fieldName.replace(/`/g, "")}_idx`)} ON ${tableName} COLUMNS ${fieldName};`);
      }
    }
    code.push("");
  }

  if (apiCfg) {
    for (const tableName of apiTableNames) {
      const path = `${apiBasePath}/${tableName}`;
      code.push(
        `DEFINE API OVERWRITE "${path}"`,
        "  FOR get",
        "  MIDDLEWARE",
        '    api::res::body("json")',
        "  THEN {",
        "    {",
        "      status: 200,",
        `      body: SELECT * FROM ${escapeIdent(tableName)}`,
        "    }",
        "  }",
        ";",
        "",
      );
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
