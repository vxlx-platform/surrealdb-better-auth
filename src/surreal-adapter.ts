import type { BetterAuthOptions } from "@better-auth/core";
import type {
  AdapterFactoryOptions,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterDebugLogOption,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import type { Expr, Surreal } from "surrealdb";
import {
  BoundQuery,
  DateTime,
  Features,
  RecordId,
  StringRecordId,
  Table,
  and,
  contains,
  eq,
  escapeIdent,
  expr,
  gt,
  gte,
  inside,
  lt,
  lte,
  ne,
  not,
  or,
} from "surrealdb";

type SurrealClient = Pick<Surreal, "query" | "beginTransaction" | "isFeatureSupported">;
type SurrealQueryClient = Pick<SurrealClient, "query">;
type SurrealTransactionClient = Awaited<ReturnType<SurrealClient["beginTransaction"]>>;

type RecordIdFormat = "native" | "uuidv7" | "ulid";

type RecordIdFormatResolver = RecordIdFormat | ((input: { model: string }) => RecordIdFormat);

type SurrealReferenceDeleteBehavior = "ignore" | "unset" | "reject" | "cascade";

type BetterAuthReferenceDeleteBehavior = NonNullable<
  NonNullable<DBFieldAttribute["references"]>["onDelete"]
>;

type SurrealReferenceDeleteBehaviorConfig = {
  default?: SurrealReferenceDeleteBehavior;
  overrides?: Record<string, SurrealReferenceDeleteBehavior>;
};

type SurrealSchemaAssertionRule = {
  email?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
};

type SurrealSchemaAssertionsConfig = {
  fields: Record<string, SurrealSchemaAssertionRule>;
  onUnsupported?: "ignore" | "error";
};

type ValidatedReferenceDeleteBehaviorConfig = {
  default?: SurrealReferenceDeleteBehavior;
  overrides: Record<string, SurrealReferenceDeleteBehavior>;
};

type ValidatedSchemaAssertionsConfig = {
  fields: Record<string, SurrealSchemaAssertionRule>;
  onUnsupported: "ignore" | "error";
};

export interface SurrealAdapterConfig {
  debugLogs?: DBAdapterDebugLogOption;
  transaction?: boolean;
  recordIdFormat?: RecordIdFormatResolver;
  defineAccess?: () => BoundQuery<unknown[]>;
  referenceDeleteBehavior?: SurrealReferenceDeleteBehaviorConfig;
  schemaAssertions?: SurrealSchemaAssertionsConfig;
}

const SUPPORTED_RECORD_ID_FORMATS = [
  "native",
  "uuidv7",
  "ulid",
] as const satisfies readonly RecordIdFormat[];

const SURREAL_REFERENCE_DELETE_BEHAVIOR_MAP = {
  ignore: "IGNORE",
  unset: "UNSET",
  reject: "REJECT",
  cascade: "CASCADE",
} as const satisfies Record<
  SurrealReferenceDeleteBehavior,
  "IGNORE" | "UNSET" | "REJECT" | "CASCADE"
>;

const BETTER_AUTH_REFERENCE_DELETE_BEHAVIOR_MAP = {
  "no action": "ignore",
  restrict: "reject",
  cascade: "cascade",
  "set null": "unset",
} as const satisfies Partial<
  Record<BetterAuthReferenceDeleteBehavior, SurrealReferenceDeleteBehavior>
>;

type SchemaField = Pick<
  DBFieldAttribute,
  "type" | "required" | "unique" | "references" | "fieldName" | "bigint"
>;

type PlainObject = Record<string, unknown>;
type QueryRows<T> = T[] | [T[]];
type TransactionRunner = Exclude<
  NonNullable<AdapterFactoryOptions["config"]["transaction"]>,
  false
>;

type SurrealSchemaFieldType =
  | "string"
  | "number"
  | "int"
  | "bool"
  | "datetime"
  | "object"
  | "array<string>"
  | "array<number>";

const FIELD_TYPE_MAP = {
  string: "string",
  number: "number",
  boolean: "bool",
  date: "datetime",
  json: "object",
  "string[]": "array<string>",
  "number[]": "array<number>",
} as const satisfies Record<string, SurrealSchemaFieldType>;

type SupportedSchemaFieldType = keyof typeof FIELD_TYPE_MAP;

const isSupportedSchemaFieldType = (
  fieldType: SchemaField["type"],
): fieldType is SupportedSchemaFieldType =>
  typeof fieldType === "string" && fieldType in FIELD_TYPE_MAP;

const unexpectedQueryRowsError = () =>
  new Error(
    "[surrealdb-adapter] Unexpected Surreal query result shape. Expected rows or a single wrapped row set.",
  );

const toResultRows = <T>(result: QueryRows<T>): T[] => {
  if (result.length === 0) return [];

  const [first] = result;
  if (Array.isArray(first)) {
    if (result.length === 1) {
      return first;
    }
    throw unexpectedQueryRowsError();
  }

  return result as T[];
};

const toTableIdent = (table: string) => new Table(table).toString();
const toEscapedFieldIdent = (field: string) => escapeIdent(field);
const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSupportedReferenceDeleteBehavior = (
  value: unknown,
): value is SurrealReferenceDeleteBehavior =>
  typeof value === "string" && value in SURREAL_REFERENCE_DELETE_BEHAVIOR_MAP;

const validateReferenceDeleteBehaviorConfig = (
  configured: SurrealReferenceDeleteBehaviorConfig | undefined,
  onError: (message: string) => never,
): ValidatedReferenceDeleteBehaviorConfig | null => {
  if (!configured) return null;

  const defaultBehavior = configured.default;
  if (defaultBehavior !== undefined && !isSupportedReferenceDeleteBehavior(defaultBehavior)) {
    onError(`Unsupported referenceDeleteBehavior default "${String(defaultBehavior)}".`);
  }

  const overrides = Object.fromEntries(
    Object.entries(configured.overrides ?? {}).map(([key, value]) => {
      if (!isSupportedReferenceDeleteBehavior(value)) {
        onError(`Unsupported referenceDeleteBehavior override "${String(value)}" for "${key}".`);
      }

      return [key, value];
    }),
  ) as Record<string, SurrealReferenceDeleteBehavior>;

  return {
    default: defaultBehavior,
    overrides,
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const validateSchemaAssertionRule = (
  key: string,
  rule: unknown,
  onError: (message: string) => never,
): SurrealSchemaAssertionRule => {
  if (!isPlainObject(rule)) {
    onError(`schemaAssertions rule for "${key}" must be an object.`);
  }

  if (rule.email !== undefined && typeof rule.email !== "boolean") {
    onError(`schemaAssertions email for "${key}" must be a boolean.`);
  }

  if (rule.minLength !== undefined && !isNonNegativeInteger(rule.minLength)) {
    onError(`schemaAssertions minLength for "${key}" must be a non-negative integer.`);
  }

  if (rule.maxLength !== undefined && !isNonNegativeInteger(rule.maxLength)) {
    onError(`schemaAssertions maxLength for "${key}" must be a non-negative integer.`);
  }

  if (rule.pattern !== undefined && typeof rule.pattern !== "string") {
    onError(`schemaAssertions pattern for "${key}" must be a string.`);
  }

  if (rule.min !== undefined && !isFiniteNumber(rule.min)) {
    onError(`schemaAssertions min for "${key}" must be a finite number.`);
  }

  if (rule.max !== undefined && !isFiniteNumber(rule.max)) {
    onError(`schemaAssertions max for "${key}" must be a finite number.`);
  }

  if (
    rule.minLength !== undefined &&
    rule.maxLength !== undefined &&
    rule.minLength > rule.maxLength
  ) {
    onError(`schemaAssertions minLength for "${key}" cannot exceed maxLength.`);
  }

  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
    onError(`schemaAssertions min for "${key}" cannot exceed max.`);
  }

  return rule;
};

const validateSchemaAssertionsConfig = (
  configured: SurrealSchemaAssertionsConfig | undefined,
  onError: (message: string) => never,
): ValidatedSchemaAssertionsConfig | null => {
  if (!configured) return null;

  const onUnsupported = configured.onUnsupported ?? "ignore";
  if (onUnsupported !== "ignore" && onUnsupported !== "error") {
    onError(`Unsupported schemaAssertions onUnsupported value "${String(onUnsupported)}".`);
  }

  const fields = Object.fromEntries(
    Object.entries(configured.fields ?? {}).map(([key, rule]) => [
      key,
      validateSchemaAssertionRule(key, rule, onError),
    ]),
  ) as Record<string, SurrealSchemaAssertionRule>;

  return {
    fields,
    onUnsupported,
  };
};

const describeValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const formatRecordId = (value: RecordId | StringRecordId): string => {
  if (value instanceof StringRecordId) {
    return value.toString();
  }

  const { table, id } = value;
  if (typeof table === "string" && (typeof id === "string" || typeof id === "number")) {
    return `${String(table)}:${String(id)}`;
  }

  return String(value);
};

const toSurrealStringLiteral = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const buildSchemaAssertionPredicates = ({
  model,
  field,
  fieldType,
  rule,
  onUnsupported,
}: {
  model: string;
  field: string;
  fieldType: SchemaField["type"];
  rule: SurrealSchemaAssertionRule;
  onUnsupported: (message: string) => void;
}): string[] => {
  const predicates: string[] = [];
  const fieldPath = `${model}.${field}`;

  if (rule.email) {
    if (fieldType !== "string") {
      onUnsupported(
        `schemaAssertions email for "${fieldPath}" requires a string field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push("string::is_email($value)");
    }
  }

  if (rule.minLength !== undefined) {
    if (fieldType !== "string") {
      onUnsupported(
        `schemaAssertions minLength for "${fieldPath}" requires a string field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push(`string::len($value) >= ${rule.minLength}`);
    }
  }

  if (rule.maxLength !== undefined) {
    if (fieldType !== "string") {
      onUnsupported(
        `schemaAssertions maxLength for "${fieldPath}" requires a string field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push(`string::len($value) <= ${rule.maxLength}`);
    }
  }

  if (rule.pattern !== undefined) {
    if (fieldType !== "string") {
      onUnsupported(
        `schemaAssertions pattern for "${fieldPath}" requires a string field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push(`string::matches($value, ${toSurrealStringLiteral(rule.pattern)})`);
    }
  }

  if (rule.min !== undefined) {
    if (fieldType !== "number") {
      onUnsupported(
        `schemaAssertions min for "${fieldPath}" requires a number field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push(`$value >= ${rule.min}`);
    }
  }

  if (rule.max !== undefined) {
    if (fieldType !== "number") {
      onUnsupported(
        `schemaAssertions max for "${fieldPath}" requires a number field, received "${String(fieldType)}".`,
      );
    } else {
      predicates.push(`$value <= ${rule.max}`);
    }
  }

  return predicates;
};

export const surrealAdapter = (client: SurrealClient, config: SurrealAdapterConfig = {}) => {
  const adapterError = (message: string, cause?: unknown) =>
    new Error(`[surrealdb-adapter] ${message}`, cause === undefined ? undefined : { cause });

  const referenceDeleteBehavior = validateReferenceDeleteBehaviorConfig(
    config.referenceDeleteBehavior,
    (message) => {
      throw adapterError(message);
    },
  );

  const schemaAssertions = validateSchemaAssertionsConfig(config.schemaAssertions, (message) => {
    throw adapterError(message);
  });

  const parseRecordIdParts = (value: string, expectedTable?: string) => {
    const separator = value.indexOf(":");
    const table = separator > 0 ? value.slice(0, separator) : "";
    const id = separator > -1 ? value.slice(separator + 1) : "";

    if (!table || !id) {
      throw adapterError(`Invalid record id "${value}". Expected the format "table:id".`);
    }

    if (expectedTable && table !== expectedTable) {
      throw adapterError(
        `Record id "${value}" references table "${table}", expected "${expectedTable}".`,
      );
    }

    return { table, id };
  };

  const toRecordReference = (value: unknown, expectedTable?: string): RecordId => {
    if (value instanceof RecordId) {
      const table = value.table;
      if (typeof table !== "string") {
        throw adapterError(
          `Expected a Surreal record id for ${expectedTable ?? "record"}, received "${formatRecordId(value)}".`,
        );
      }
      if (expectedTable && table !== expectedTable) {
        throw adapterError(
          `Record id "${formatRecordId(value)}" references table "${String(table)}", expected "${String(expectedTable)}".`,
        );
      }
      return value;
    }

    const asString =
      value instanceof StringRecordId ? value.toString() : typeof value === "string" ? value : null;

    if (!asString) {
      throw adapterError(
        `Expected a Surreal record id for ${expectedTable ?? "record"}, received "${describeValue(value)}".`,
      );
    }

    const { table, id } = parseRecordIdParts(asString, expectedTable);
    return new RecordId(table, id);
  };

  const toRecordIdInput = (
    value: unknown,
    expectedTable?: string,
  ): RecordId | RecordId[] | null | undefined => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      // Defensive support for list-shaped id/reference values.
      return value.map((entry) => toRecordReference(entry, expectedTable));
    }
    return toRecordReference(value, expectedTable);
  };

  const resolveRecordIdFormat = (resolver: RecordIdFormatResolver | undefined, model: string) => {
    const raw = typeof resolver === "function" ? resolver({ model }) : (resolver ?? "native");
    // Runtime guard for JS callers or unsafe casts that bypass the TypeScript union.
    if (!SUPPORTED_RECORD_ID_FORMATS.includes(raw)) {
      throw adapterError(
        `Unsupported recordIdFormat "${String(raw)}". Supported values are "native", "uuidv7", and "ulid".`,
      );
    }
    return raw;
  };

  const createTargetExpression = (table: string, format: RecordIdFormat): string => {
    const escapedTable = toTableIdent(table);
    if (format === "uuidv7") return `${escapedTable}:uuid()`;
    if (format === "ulid") return `${escapedTable}:ulid()`;
    return escapedTable;
  };

  const resolveSchemaType = (modelName: string, fieldName: string, field: SchemaField) => {
    if (field.type === "number" && field.bigint) {
      return "int" satisfies SurrealSchemaFieldType;
    }

    const fieldType = field.type;
    if (!isSupportedSchemaFieldType(fieldType)) {
      throw adapterError(
        `Unsupported schema field type "${String(fieldType)}" for "${modelName}.${fieldName}".`,
      );
    }
    return FIELD_TYPE_MAP[fieldType];
  };

  const isMappedReferenceDeleteBehavior = (
    v: string,
  ): v is keyof typeof BETTER_AUTH_REFERENCE_DELETE_BEHAVIOR_MAP =>
    v in BETTER_AUTH_REFERENCE_DELETE_BEHAVIOR_MAP;

  const resolveReferenceDeleteBehavior = ({
    model,
    field,
    reference,
  }: {
    model: string;
    field: string;
    reference: NonNullable<SchemaField["references"]>;
  }): SurrealReferenceDeleteBehavior => {
    const overrideKey = `${model}.${field}`;

    const override = referenceDeleteBehavior?.overrides[overrideKey];
    if (override !== undefined) return override;

    const { onDelete } = reference;
    if (onDelete !== undefined) {
      if (!isMappedReferenceDeleteBehavior(onDelete)) {
        throw adapterError(
          `Unsupported Better Auth onDelete behavior "${onDelete}" for "${overrideKey}".`,
        );
      }
      return BETTER_AUTH_REFERENCE_DELETE_BEHAVIOR_MAP[onDelete];
    }

    return referenceDeleteBehavior?.default ?? "cascade";
  };

  const buildSchemaAssertionClause = ({
    model,
    field,
    fieldAttributes,
  }: {
    model: string;
    field: string;
    fieldAttributes: SchemaField;
  }): string => {
    const rule = schemaAssertions?.fields[`${model}.${field}`];
    if (!rule) return "";

    const failUnsupported = (message: string) => {
      if (schemaAssertions?.onUnsupported === "error") {
        throw adapterError(message);
      }
    };
    const predicates = buildSchemaAssertionPredicates({
      model,
      field,
      fieldType: fieldAttributes.type,
      rule,
      onUnsupported: failUnsupported,
    });

    if (predicates.length === 0) return "";

    const condition = predicates.length === 1 ? predicates[0]! : predicates.join(" AND ");
    return ` ASSERT ${fieldAttributes.required ? condition : `$value = NONE OR (${condition})`}`;
  };

  const generateSchemaCode = ({
    file,
    tables,
    getModelName,
    getFieldName,
  }: {
    file?: string | undefined;
    tables: BetterAuthDBSchema;
    getModelName: (model: string) => string;
    getFieldName: ({ model, field }: { model: string; field: string }) => string;
  }) => {
    const buildIndexName = (tableName: string, fieldName: string): string => {
      const normalizedTable = tableName.replace(/`/g, "").toLowerCase();
      const normalizedField = fieldName.replace(/`/g, "");
      const capitalizedField = normalizedField
        ? normalizedField.charAt(0).toUpperCase() + normalizedField.slice(1)
        : "";
      return `${normalizedTable}${capitalizedField}_idx`;
    };

    const buildSchemaFieldLines = ({
      modelKey,
      tableModelName,
      tableName,
      fieldKey,
      field,
    }: {
      modelKey: string;
      tableModelName: string;
      tableName: string;
      fieldKey: string;
      field: SchemaField & { index?: boolean };
    }): string[] => {
      const dbFieldName = field.fieldName ?? fieldKey;
      if (dbFieldName === "id") return [];

      const resolvedField = toEscapedFieldIdent(
        getFieldName({ model: tableModelName, field: dbFieldName }),
      );
      const fieldType = field.references
        ? `record<${toTableIdent(getModelName(field.references.model))}>`
        : resolveSchemaType(tableModelName, dbFieldName, field);
      const requiredType = field.required ? fieldType : `option<${fieldType}>`;
      const referenceClause = field.references
        ? ` REFERENCE ON DELETE ${
            SURREAL_REFERENCE_DELETE_BEHAVIOR_MAP[
              resolveReferenceDeleteBehavior({
                model: modelKey,
                field: fieldKey,
                reference: field.references,
              })
            ]
          }`
        : "";
      const assertionClause = buildSchemaAssertionClause({
        model: modelKey,
        field: fieldKey,
        fieldAttributes: field,
      });
      const fieldDefinition = `DEFINE FIELD OVERWRITE ${resolvedField} ON TABLE ${tableName} TYPE ${requiredType}${referenceClause}${assertionClause};`;
      if (!field.unique && !field.index) return [fieldDefinition];

      const indexName = buildIndexName(tableName, resolvedField);
      const uniquenessClause = field.unique ? " UNIQUE" : "";
      const indexDefinition = `DEFINE INDEX OVERWRITE ${escapeIdent(indexName)} ON TABLE ${tableName} COLUMNS ${resolvedField}${uniquenessClause};`;
      return [fieldDefinition, indexDefinition];
    };

    const schemaLines = Object.entries(tables).flatMap(([modelKey, table]) => {
      const tableName = toTableIdent(getModelName(table.modelName));
      const fieldLines = Object.entries(table.fields).flatMap(([fieldKey, field]) =>
        buildSchemaFieldLines({
          modelKey,
          tableModelName: table.modelName,
          tableName,
          fieldKey,
          field,
        }),
      );

      return [`DEFINE TABLE OVERWRITE ${tableName} SCHEMAFULL;`, ...fieldLines, ""];
    });

    const accessStatement = (() => {
      if (typeof config.defineAccess === "function") {
        const bound = config.defineAccess();
        if (Object.keys(bound.bindings).length > 0) {
          const placeholders = Object.keys(bound.bindings).map((key) => `$${key}`);
          throw adapterError(
            `defineAccess must not include bindings in schema generation. Use static surql or inline dynamic values with raw(...). Found: ${placeholders.join(", ")}.`,
          );
        }
        const statement = bound.query.trim();
        return statement.length > 0 ? statement : null;
      }
      return null;
    })();

    const lines = accessStatement
      ? [
          ...schemaLines,
          accessStatement.endsWith(";") ? accessStatement : `${accessStatement};`,
          "",
        ]
      : schemaLines;

    const suggestedPath = file ? file.replace(/\.[^/.]+$/, ".surql") : ".better-auth/schema.surql";
    return {
      code: lines.join("\n"),
      path: suggestedPath,
    };
  };

  const normalizeDateValue = (value: unknown) =>
    value instanceof DateTime ? value.toDate() : value;

  const normalizeRecordIdValue = (value: unknown): unknown => {
    if (value instanceof RecordId || value instanceof StringRecordId) {
      return formatRecordId(value);
    }

    return value;
  };

  // `field` is pre-escaped with `escapeIdent`; only the value is parameterized here.
  const startsWithExpr = (field: string, value: string): Expr => ({
    toSQL: (ctx) => `string::starts_with(${field}, ${ctx.def(value)})`,
  });

  // `field` is pre-escaped with `escapeIdent`; only the value is parameterized here.
  const endsWithExpr = (field: string, value: string): Expr => ({
    toSQL: (ctx) => `string::ends_with(${field}, ${ctx.def(value)})`,
  });

  type SupportedWhereOperator =
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "in"
    | "not_in"
    | "contains"
    | "starts_with"
    | "ends_with";

  const supportedWhereOperators = [
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "not_in",
    "contains",
    "starts_with",
    "ends_with",
  ] as const satisfies readonly SupportedWhereOperator[];
  const supportedWhereOperatorSet: ReadonlySet<string> = new Set(supportedWhereOperators);

  const isSupportedWhereOperator = (value: unknown): value is SupportedWhereOperator =>
    typeof value === "string" && supportedWhereOperatorSet.has(value);

  const expectStringValue = (value: unknown, operator: "starts_with" | "ends_with"): string => {
    if (typeof value === "string") return value;
    throw adapterError(`Operator "${operator}" requires a string value.`);
  };

  const expectArrayValue = (value: unknown, operator: "in" | "not_in"): unknown[] => {
    if (Array.isArray(value)) return value;
    throw adapterError(`Operator "${operator}" requires an array value.`);
  };

  const resolveWhereOperator = (value: unknown): SupportedWhereOperator => {
    if (value === undefined) return "eq";
    if (isSupportedWhereOperator(value)) return value;
    throw adapterError(`Unsupported where operator "${describeValue(value)}".`);
  };

  const buildUpdateSetStatement = (
    update: PlainObject,
  ): { setClause: string; bindings: PlainObject } => {
    const definedEntries = Object.entries(update).filter(([, value]) => value !== undefined);

    const fragments = definedEntries.map(([field, value], index) => {
      if (value === null) {
        return {
          assignment: `${toEscapedFieldIdent(field)} = NONE`,
          binding: null,
        } as const;
      }

      const key = `__upd_${index}__`;
      return {
        assignment: `${toEscapedFieldIdent(field)} = $${key}`,
        binding: [key, value] as const,
      } as const;
    });

    return {
      setClause: fragments.map(({ assignment }) => assignment).join(", "),
      bindings: Object.fromEntries(fragments.flatMap(({ binding }) => (binding ? [binding] : []))),
    };
  };

  const whereOperatorExprBuilders = {
    eq: (field: string, value: unknown): Expr => eq(field, value),
    ne: (field: string, value: unknown): Expr => ne(field, value),
    lt: (field: string, value: unknown): Expr => lt(field, value),
    lte: (field: string, value: unknown): Expr => lte(field, value),
    gt: (field: string, value: unknown): Expr => gt(field, value),
    gte: (field: string, value: unknown): Expr => gte(field, value),
    contains: (field: string, value: unknown): Expr => contains(field, value),
    in: (field: string, value: unknown): Expr => inside(field, expectArrayValue(value, "in")),
    not_in: (field: string, value: unknown): Expr =>
      not(inside(field, expectArrayValue(value, "not_in"))),
    starts_with: (field: string, value: unknown): Expr =>
      startsWithExpr(field, expectStringValue(value, "starts_with")),
    ends_with: (field: string, value: unknown): Expr =>
      endsWithExpr(field, expectStringValue(value, "ends_with")),
  } as const satisfies Record<SupportedWhereOperator, (field: string, value: unknown) => Expr>;

  const whereOperatorExpr = (
    operator: SupportedWhereOperator,
    field: string,
    value: unknown,
  ): Expr => whereOperatorExprBuilders[operator](field, value);

  const supportsTransactions = (): boolean => {
    if (config.transaction === false) return false;
    if (typeof client.beginTransaction !== "function") return false;
    if (typeof client.isFeatureSupported !== "function") return true;
    return client.isFeatureSupported(Features.Transactions);
  };

  const buildWhereClause = (where: CleanedWhere[] | undefined): BoundQuery => {
    if (!where || where.length === 0) return new BoundQuery("");

    const first = where[0]!;

    const toConditionExpr = (item: CleanedWhere): Expr => {
      const field = toEscapedFieldIdent(item.field);
      const operator = resolveWhereOperator(item.operator);
      return whereOperatorExpr(operator, field, item.value);
    };

    const condition = where.slice(1).reduce((acc, item) => {
      const next = toConditionExpr(item);
      return item.connector === "OR" ? or(acc, next) : and(acc, next);
    }, toConditionExpr(first));

    const compiled = expr(condition);
    if (!compiled.query) return new BoundQuery("");
    return new BoundQuery(`WHERE ${compiled.query}`, compiled.bindings);
  };

  const createCustomAdapter =
    (db: SurrealQueryClient) =>
    ({
      getFieldName,
      getModelName,
    }: Parameters<NonNullable<AdapterFactoryOptions["adapter"]>>[0]) => {
      const execQuery = async <T>(query: BoundQuery) =>
        toResultRows<T>(await db.query<QueryRows<T>>(query.query, query.bindings));

      const execQueryFirst = async <T>(query: BoundQuery) => (await execQuery<T>(query))[0] ?? null;

      const appendWhereClause = (query: BoundQuery, whereClause: BoundQuery): void => {
        if (!whereClause.query) return;
        query.append(new BoundQuery(` ${whereClause.query}`, whereClause.bindings));
      };

      const buildSelectColumns = (model: string, select?: string[]) =>
        select && select.length > 0
          ? select.map((field) => toEscapedFieldIdent(getFieldName({ model, field }))).join(", ")
          : "*";

      const countRecords = async (model: string, where?: CleanedWhere[]) => {
        const tableName = toTableIdent(getModelName(model));
        const whereClause = buildWhereClause(where);
        const query = new BoundQuery(`SELECT count() AS total FROM ${tableName}`);
        appendWhereClause(query, whereClause);
        query.append(" GROUP ALL;");

        const row = await execQueryFirst<{ total: number }>(query);
        return row?.total ?? 0;
      };

      const customAdapter: CustomAdapter = {
        async create<T extends PlainObject>({
          model,
          data,
        }: {
          model: string;
          data: T;
          select?: string[] | undefined;
        }): Promise<T> {
          const table = getModelName(model);
          const format = resolveRecordIdFormat(config.recordIdFormat, table);

          const query = new BoundQuery(
            `CREATE ONLY ${createTargetExpression(table, format)} CONTENT $data RETURN AFTER;`,
            { data },
          );

          const created = await execQueryFirst<T>(query);
          if (!created) throw adapterError(`Failed to create ${table} record.`);
          return created;
        },

        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[] | undefined;
        }): Promise<T | null> {
          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);
          const query = new BoundQuery(
            `SELECT ${buildSelectColumns(model, select)} FROM ${tableName}`,
          );
          appendWhereClause(query, whereClause);
          query.append(" LIMIT 1;");

          return await execQueryFirst<T>(query);
        },

        async findMany<T>({
          model,
          where,
          sortBy,
          limit,
          offset,
          select,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
          limit: number;
          select?: string[] | undefined;
          sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
          offset?: number | undefined;
        }): Promise<T[]> {
          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);
          const query = new BoundQuery(
            `SELECT ${buildSelectColumns(model, select)} FROM ${tableName}`,
          );
          appendWhereClause(query, whereClause);

          if (sortBy) {
            const sortField = toEscapedFieldIdent(getFieldName({ model, field: sortBy.field }));
            const direction = sortBy.direction === "desc" ? "DESC" : "ASC";
            query.append(new BoundQuery(` ORDER BY ${sortField} ${direction}`));
          }

          if (typeof limit === "number") {
            query.append(" LIMIT $limit", { limit });
          }

          if (typeof offset === "number") {
            query.append(" START $offset", { offset });
          }
          query.append(";");

          return await execQuery<T>(query);
        },

        count({
          model,
          where,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
        }): Promise<number> {
          return countRecords(model, where);
        },

        async update<T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: T;
        }): Promise<T | null> {
          if (!isPlainObject(update)) {
            throw adapterError(`Expected update payload for "${model}" to be a plain object.`);
          }

          const { setClause, bindings } = buildUpdateSetStatement(update);

          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);

          if (!setClause) {
            // Better Auth may pass update payloads whose fields normalize to `undefined`.
            // In that case we treat the operation as a no-op and return the current record.
            const query = new BoundQuery(`SELECT * FROM ${tableName}`);
            appendWhereClause(query, whereClause);
            query.append(" LIMIT 1;");
            return await execQueryFirst<T>(query);
          }

          const query = new BoundQuery(`UPDATE ONLY ${tableName} SET ${setClause}`, bindings);
          appendWhereClause(query, whereClause);
          query.append(" RETURN AFTER;");
          return await execQueryFirst<T>(query);
        },

        async updateMany({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: Record<string, unknown>;
        }): Promise<number> {
          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);
          const { setClause, bindings } = buildUpdateSetStatement(update);
          if (!setClause) return 0;

          const query = new BoundQuery(`UPDATE ${tableName} SET ${setClause}`, bindings);
          appendWhereClause(query, whereClause);
          query.append(" RETURN AFTER;");
          const updated = await execQuery<Record<string, unknown>>(query);
          return updated.length;
        },

        async delete({ model, where }: { model: string; where: CleanedWhere[] }): Promise<void> {
          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);
          // Better Auth single-record delete paths are expected to resolve to one row.
          // `DELETE ONLY` preserves that contract and lets Surreal reject ambiguous filters.
          const query = new BoundQuery(`DELETE ONLY ${tableName}`);
          appendWhereClause(query, whereClause);
          query.append(" RETURN BEFORE;");
          await execQuery(query);
        },

        async deleteMany({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }): Promise<number> {
          const tableName = toTableIdent(getModelName(model));
          const whereClause = buildWhereClause(where);
          const query = new BoundQuery(`DELETE ${tableName}`);
          appendWhereClause(query, whereClause);
          query.append(" RETURN BEFORE;");
          const deleted = await execQuery<Record<string, unknown>>(query);
          return deleted.length;
        },

        async createSchema({
          file,
          tables,
        }: {
          file?: string | undefined;
          tables: BetterAuthDBSchema;
        }) {
          return generateSchemaCode({
            tables,
            getFieldName,
            getModelName,
            ...(file ? { file } : {}),
          });
        },

        options: config,
      };

      return customAdapter;
    };

  const enableTransactions = supportsTransactions();
  const baseAdapterConfig = {
    adapterId: "surrealdb",
    adapterName: "SurrealDB Adapter",
    usePlural: false,
    debugLogs: config.debugLogs ?? false,
    supportsJSON: true,
    supportsArrays: true,
    supportsDates: true,
    supportsBooleans: true,
    disableIdGeneration: true,
    supportsNumericIds: false,
    supportsUUIDs: false,
    customTransformInput: ({ data, field, fieldAttributes, model, schema, action }) => {
      if (data === undefined) return data;
      if (data === null) {
        // Better Auth uses nullable optionals (for example user.image in test-utils),
        // while Surreal schema fields are expressed as `none | type`. Omitting the
        // field on create maps that nullish input to Surreal's NONE semantics.
        if (action === "create") return undefined;
        return data;
      }

      const tables = schema as BetterAuthDBSchema;
      const currentTable = tables[model]?.modelName ?? model;

      if (fieldAttributes.type === "date" && data instanceof Date) {
        return new DateTime(data);
      }

      if (field === "id") {
        // Keep SurrealDB as source of truth for record-id generation on create.
        if (action === "create") return undefined;
        return toRecordIdInput(data, currentTable);
      }

      if (fieldAttributes.references?.field === "id") {
        const targetTable = tables[fieldAttributes.references.model]?.modelName;
        if (!targetTable) return data;
        return toRecordIdInput(data, targetTable);
      }

      return data;
    },
    customTransformOutput: ({ data, field, fieldAttributes }) => {
      if (data === undefined || data === null) return data;

      if (fieldAttributes.type === "date") {
        return normalizeDateValue(data);
      }

      const isIdLikeField = field === "id" || fieldAttributes.references?.field === "id";
      if (!isIdLikeField) return data;

      return normalizeRecordIdValue(data);
    },
  } satisfies Omit<AdapterFactoryOptions["config"], "transaction">;

  const createFactoryOptions = (
    db: SurrealQueryClient,
    transaction: AdapterFactoryOptions["config"]["transaction"],
  ): AdapterFactoryOptions => ({
    config: {
      ...baseAdapterConfig,
      transaction,
    },
    adapter: createCustomAdapter(db),
  });

  const createTransactionRunner =
    (options: BetterAuthOptions): TransactionRunner =>
    async (callback) => {
      const tx: SurrealTransactionClient = await client.beginTransaction();
      const txAdapter = createAdapterFactory(createFactoryOptions(tx, false))(options);

      try {
        const result = await callback(txAdapter);
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.cancel();
        } catch {
          // Ignore cancellation failures and preserve the original failure.
        }
        throw error;
      }
    };

  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> =>
    createAdapterFactory(
      createFactoryOptions(client, enableTransactions ? createTransactionRunner(options) : false),
    )(options);
};
