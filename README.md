# @vxlx/surrealdb-better-auth

SurrealDB adapter for [Better Auth](https://www.better-auth.com/) built for the SurrealDB JavaScript SDK v2.

This adapter treats Better Auth `id` values as SurrealDB record id components (`table:id`) instead of a persisted `id` column.

## Why this adapter

If you're using Better Auth with the SurrealDB JavaScript SDK v2 client, this adapter gives you a native integration layer instead of forcing a SQL-style adapter shape onto SurrealDB.

- Built against the SurrealDB JavaScript SDK v2 API
- Fits modern SurrealDB v3 deployments
- Uses SurrealDB record ids as first-class identifiers
- Preserves Better Auth's current adapter factory integration
- Handles record links and id normalization automatically

## Features

- SurrealDB JavaScript SDK v2-first adapter for Better Auth
- Better Auth adapter factory integration (`createAdapterFactory`)
- Full CRUD support (`create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`)
- SurrealDB record-link support for referenced fields (`record<...>`)
- Configurable record id generation strategy:
  - `random` (default)
  - `ulid`
  - `uuidv7`
  - per-table function
- Schema generation helper for Better Auth tables (`createSchema` / `generateSurqlSchema`)
- Output normalization so Better Auth sees plain ids instead of `table:id`

## Supported and Tested CRUD Operations

The adapter currently supports and is covered by integration tests for the following operations:

- ✅ **`create`**
- ✅ **`findOne`**
- ✅ **`findMany`**
- ✅ **`count`**
- ✅ **`update`**
- ✅ **`updateMany`**
- ✅ **`delete`**
- ✅ **`deleteMany`**

## Supported Query Operators

The adapter currently implements the following filter operators for `where` clauses:

- ✅ **`eq`**
- ✅ **`ne`**
- ✅ **`lt`**
- ✅ **`lte`**
- ✅ **`gt`**
- ✅ **`gte`**
- ✅ **`contains`**
- ✅ **`in`**
- ✅ **`starts_with`**
- ✅ **`ends_with`**

Boolean connectors:

- ✅ **`AND`**
- ✅ **`OR`**

When you filter by related records, the adapter automatically converts those values into SurrealDB `RecordId`s for you.

### Query Operator Examples

```ts
const builtConfig = auth.options;
const adapterFactory = builtConfig.database as any;
const adapter = adapterFactory({ plugins: builtConfig.plugins });

const recentVerifiedUsers = await adapter.findMany({
  model: "user",
  where: [
    { field: "emailVerified", operator: "eq", value: true },
    { field: "createdAt", operator: "gte", value: new Date("2026-01-01") },
  ],
  sortBy: { field: "createdAt", direction: "desc" },
  limit: 10,
});

const accountsForProviders = await adapter.findMany({
  model: "account",
  where: [{ field: "providerId", operator: "in", value: ["google", "github"] }],
});

const sessionsForUser = await adapter.findMany({
  model: "session",
  where: [{ field: "userId", operator: "eq", value: "user_123" }],
});

const usersMatchingSearch = await adapter.findMany({
  model: "user",
  where: [
    { field: "email", operator: "ends_with", value: "@example.com" },
    { field: "name", operator: "starts_with", value: "A", connector: "OR" },
  ],
});
```

## Installation

```bash
bun add @vxlx/surrealdb-better-auth better-auth surrealdb
```

This package is intended for projects using the current `surrealdb` JavaScript SDK v2 package.

## Requirements

- A connected/authenticated SurrealDB JavaScript SDK v2 client
- Better Auth configured to not generate DB ids

## Basic Usage

```ts
import { betterAuth } from "better-auth";
import { surrealAdapter } from "@vxlx/surrealdb-better-auth";
import { Surreal } from "surrealdb";

const db = new Surreal();
await db.connect("ws://localhost:8000/rpc");
await db.signin({ username: "root", password: "root" });
await db.use({ namespace: "main", database: "main" });

export const auth = betterAuth({
  database: surrealAdapter(db),
  advanced: {
    database: {
      generateId: false,
    },
  },
  emailAndPassword: {
    enabled: true,
  },
});
```

The adapter accepts the v2 `Surreal` client directly and uses SDK-native types such as `RecordId` for id and relation handling internally.

## Adapter Options

```ts
import { surrealAdapter, type SurrealAdapterConfig } from "@vxlx/surrealdb-better-auth";

const config: SurrealAdapterConfig = {
  usePlural: false,
  debugLogs: false,
  recordIdFormat: "native", // "native" | "ulid" | "uuidv7" | (tableName) => ...
};

const adapter = surrealAdapter(db, config);
```

### `recordIdFormat`

You can set a global id format:

```ts
surrealAdapter(db, { recordIdFormat: "uuidv7" });
```

Or control format by table:

```ts
surrealAdapter(db, {
  recordIdFormat: (tableName) => {
    if (tableName === "user") return "uuidv7";
    if (tableName === "account") return "ulid";
    return "native";
  },
});
```

## ID / Reference Behavior

- Primary ids are represented as SurrealDB record ids (e.g. `user:abc123`) internally.
- Adapter output normalizes ids to plain components (`abc123`) for Better Auth.
- Reference fields are transformed to `RecordId` values on writes/filters and normalized back on reads.

This lets Better Auth continue working with plain string ids while the SurrealDB JavaScript SDK v2 keeps native record semantics under the hood.

## Schema Generation

The adapter exposes Better Auth `createSchema` and a standalone helper.

### Via Better Auth adapter instance

```ts
const builtConfig = auth.options;
const adapterFactory = builtConfig.database as any;
const adapter = adapterFactory({ plugins: builtConfig.plugins });

const result = await adapter.createSchema(builtConfig, "better-auth-schema.surql");
await db.query(result.code);
```

### Standalone helper

```ts
import { generateSurqlSchema } from "@vxlx/surrealdb-better-auth";

const result = await generateSurqlSchema({
  file: "better-auth-schema.ts",
  tables,
  getModelName,
  getFieldName,
});

// result.path -> "better-auth-schema.surql"
// result.code -> SurQL
```

## Exported API

- `surrealAdapter(db, config?)`
- `generateSurqlSchema(options)`
- Types:
  - `SurrealAdapterConfig`
  - `RecordIdFormat`
  - `GenerateSurqlSchemaOptions`

## Development

```bash
bun run build
bun run test
```

Note: Integration tests require a local SurrealDB instance reachable at `ws://localhost:8000/rpc`, accessed through the current SurrealDB JavaScript SDK v2 client and credentials used in the test helpers.

Test DB scope can be configured with:

- `SURREALDB_TEST_NAMESPACE` (default: `main`)
- `SURREALDB_TEST_DATABASE` (default: `main`)
- `SURREALDB_TEST_ISOLATE=1` to append worker ids for parallel isolation
