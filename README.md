# @vxlx/surrealdb-better-auth

SurrealDB adapter for [Better Auth](https://www.better-auth.com/) using the current adapter factory API.

This adapter treats Better Auth `id` values as SurrealDB record id components (`table:id`) instead of a persisted `id` column.

## Features

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

## Installation

```bash
bun add @vxlx/surrealdb-better-auth better-auth surrealdb
```

## Requirements

- A connected/authenticated SurrealDB client
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

## Adapter Options

```ts
import { surrealAdapter, type SurrealAdapterConfig } from "@vxlx/surrealdb-better-auth";

const config: SurrealAdapterConfig = {
  usePlural: false,
  debugLogs: false,
  recordIdFormat: "random", // "random" | "ulid" | "uuidv7" | (tableName) => ...
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
    return "random";
  },
});
```

## ID / Reference Behavior

- Primary ids are represented as SurrealDB record ids (e.g. `user:abc123`) internally.
- Adapter output normalizes ids to plain components (`abc123`) for Better Auth.
- Reference fields are transformed to `RecordId` values on writes/filters and normalized back on reads.

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

Note: Integration tests require a local SurrealDB instance reachable at `ws://localhost:8000/rpc` with credentials used in the test helpers.

Test DB scope can be configured with:
- `SURREALDB_TEST_NAMESPACE` (default: `main`)
- `SURREALDB_TEST_DATABASE` (default: `main`)
- `SURREALDB_TEST_ISOLATE=1` to append worker ids for parallel isolation
