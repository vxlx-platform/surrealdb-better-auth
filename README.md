# @vxlx/surrealdb-better-auth

SurrealDB-first [Better Auth](https://www.better-auth.com/) adapter for the SurrealDB JavaScript SDK (`table:id` contract).

## Install

```bash
npm install @vxlx/surrealdb-better-auth better-auth surrealdb
```

## Quick start

```ts
import { betterAuth } from "better-auth";
import { surrealAdapter } from "@vxlx/surrealdb-better-auth";
import { Surreal, surql } from "surrealdb";

const db = new Surreal();
await db.connect("ws://localhost:8000/rpc");
await db.signin({ username: "root", password: "root" });
await db.use({ namespace: "main", database: "main" });

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: surrealAdapter(db, {
    recordIdFormat: "native",
    defineAccess: () => surql`
      DEFINE ACCESS OVERWRITE user_access ON DATABASE
        TYPE RECORD
        WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known/jwks.json";
    `,
  }),
  advanced: { database: { generateId: false } },
  emailAndPassword: { enabled: true },
});
```

## Core behavior

- Strict id/reference inputs: `RecordId`, `StringRecordId`, or `table:id`
- Persists Better Auth relationships as SurrealDB record references and emits `REFERENCE` fields in generated schema
- Honors Better Auth reference delete semantics in generated schema and supports adapter-level `ON DELETE` overrides
- Emits Surreal `int` schema fields for Better Auth numeric fields marked with `bigint: true`
- Supports opt-in simple schema `ASSERT` generation for explicit field rules such as email, string length, regex, and numeric ranges
- SurrealDB-native UUIDv7 and ULID support
- Rejects bare ids and wrong-table references
- Uses `RecordId` bindings internally while normalizing adapter outputs back to canonical `table:id` strings
- Single-record `update()` / `delete()` use SurrealDB `ONLY ... WHERE ...`, so fields used as single-record lookup keys should be uniquely indexed
- Better Auth transaction support via SurrealDB session transactions, with automatic fallback when transactions are unavailable
- Schema generation support with optional `defineAccess` for fine-grained access control

## Adapter options

- `debugLogs?: boolean`
- `recordIdFormat?: "native" | "ulid" | "uuidv7" | (({ model }) => ...)`
- `transaction?: boolean` — when enabled, the adapter uses SurrealDB transactions if `beginTransaction` is available and the client reports transaction support; if feature probing is unavailable but `beginTransaction` exists, transactions are still enabled
- `defineAccess?: () => BoundQuery`
- `referenceDeleteBehavior?: { default?: "ignore" | "unset" | "reject" | "cascade"; overrides?: Record<string, ...> }` — applies schema-level `REFERENCE ON DELETE ...` behavior for generated reference fields; Better Auth-provided `onDelete` metadata takes precedence over the adapter default
- `schemaAssertions?: { fields: Record<string, { email?: boolean; minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number }>; onUnsupported?: "ignore" | "error" }` — opt-in schema-only `ASSERT` generation for explicit `model.field` rules; unsupported rule/type combinations are ignored by default or can fail fast with `onUnsupported: "error"`

### Simple schema assertions

Use `schemaAssertions` when you want a small set of SurrealDB-native checks in generated schema without trying to translate arbitrary Better Auth validators.

```ts
database: surrealAdapter(db, {
  schemaAssertions: {
    fields: {
      "user.email": { email: true },
      "user.username": {
        minLength: 3,
        maxLength: 32,
        pattern: "^[a-z0-9_]+$",
      },
      "user.age": { min: 13, max: 120 },
    },
  },
});
```

This emits SurrealQL such as `ASSERT string::is_email($value)` and wraps optional fields as `ASSERT $value = NONE OR (...)`.
