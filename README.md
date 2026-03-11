# @vxlx/surrealdb-better-auth

SurrealDB adapter for [Better Auth](https://www.better-auth.com/) built for the SurrealDB JavaScript SDK v2.

This adapter treats Better Auth `id` values as SurrealDB record id components (`table:id`) instead of a persisted `id` column.

- npm: [`@vxlx/surrealdb-better-auth`](https://www.npmjs.com/package/@vxlx/surrealdb-better-auth)
- repository: [vxlx-platform/surrealdb-better-auth](https://github.com/vxlx-platform/surrealdb-better-auth)

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
- Better Auth transaction support via `adapter.transaction(...)`
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
npm install @vxlx/surrealdb-better-auth better-auth surrealdb
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

## Transactions

The adapter implements Better Auth's transaction hook using the SurrealDB JavaScript SDK v2 session transaction API. Internally it forks the active session, starts a transaction, runs the callback against that transaction-scoped session, and then commits or cancels it.

Usage:

```ts
await adapter.transaction(async (trx) => {
  const user = await trx.create({
    model: "user",
    data: {
      name: "Transactional User",
      email: "tx@example.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await trx.create({
    model: "session",
    data: {
      userId: user.id,
      token: "session-token",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
});
```

If the callback throws, the adapter cancels the transaction and rethrows the original error.

## Schema Generation

The adapter exposes Better Auth `createSchema`, a standalone helper, and an explicit schema-apply helper.

### Via Better Auth adapter instance

```ts
const builtConfig = auth.options;
const adapterFactory = builtConfig.database as any;
const adapter = adapterFactory({ plugins: builtConfig.plugins });

const result = await adapter.createSchema(builtConfig, "better-auth-schema.surql");
await db.query(result.code);
```

### Apply schema programmatically

```ts
import { applySurqlSchema } from "@vxlx/surrealdb-better-auth";

await applySurqlSchema({
  db,
  authOptions: auth.options,
  file: "better-auth-schema.surql",
});
```

`applySurqlSchema(...)` applies the generated SurQL statement-by-statement so repeated runs remain idempotent and do not abort on earlier `DEFINE TABLE ... already exists` errors.

### Run as a migration script

Export both your Better Auth instance and connected Surreal client:

```ts
// auth.ts
export { auth, db };
```

Then add a script in your app:

```json
{
  "scripts": {
    "migration": "bunx surrealdb-better-auth migrate --config ./auth.ts"
  }
}
```

The CLI looks for `auth` and `db` exports by default. If your exports use different names, pass them explicitly:

```json
{
  "scripts": {
    "migration": "bunx surrealdb-better-auth migrate --config ./auth.ts --auth myAuth --db myDB"
  }
}
```

### Quick Bun server for local testing

This repo also includes a minimal Bun server you can use to verify the live Better Auth routes against a local database:

```bash
bun run dev:server
```

Defaults:

- Better Auth base: `http://localhost:3000/api/auth`
- JWKS route: `http://localhost:3000/api/auth/.well-known`
- SurrealDB WS endpoint: `ws://localhost:8000/rpc`
- SurrealDB API endpoint base: `http://localhost:8000/api/main/main`

Environment variables:

- `PORT`
- `SURREALDB_ENDPOINT`
- `SURREALDB_USERNAME`
- `SURREALDB_PASSWORD`
- `SURREALDB_NAMESPACE`
- `SURREALDB_DATABASE`
- `JWT_JWKS_PATH`
- `SURREALDB_ACCESS`

`SURREALDB_ACCESS` is optional. When it is set, the example server shapes Better Auth JWTs for SurrealDB record access by including:

- `exp`
- `id` as a record id such as `user:abc123`
- `sub` as the same record id
- `ac`
- `ns`
- `db`
- `email`

The value must match the SurrealDB access method name from `DEFINE ACCESS ... TYPE RECORD WITH JWT`, for example:

```surql
DEFINE ACCESS better_auth_user
  ON DATABASE
  TYPE RECORD
  WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known";
```

```bash
SURREALDB_ACCESS=better_auth_user bun run dev:server
```

If `SURREALDB_ACCESS` is not set, the example server emits a more generic Better Auth JWT payload instead of SurrealDB-specific record-access claims.

## JWT Auth with SurrealDB Record Access

If you want SurrealDB to accept Better Auth JWTs directly, define a record access method that trusts your Better Auth JWKS endpoint:

```surql
DEFINE ACCESS better_auth_user
  ON DATABASE
  TYPE RECORD
  WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known";
```

For SurrealDB `TYPE RECORD ... WITH JWT`, the JWT should include:

- `exp`
- `ns`
- `db`
- `ac`
- `id` as a record id such as `user:abc123`

The example Bun server can shape tokens for this flow when `SURREALDB_ACCESS` is set to the same access name:

```bash
SURREALDB_ACCESS=better_auth_user bun run dev:server
```

Then you can fetch a Better Auth token from your app and authenticate a SurrealDB client with it:

```ts
const tokenResponse = await fetch("http://127.0.0.1:3000/api/auth/token", {
  credentials: "include",
});

const { token } = await tokenResponse.json();

const db = new Surreal();
await db.connect("ws://127.0.0.1:8000/rpc");
await db.use({ namespace: "main", database: "main" });
await db.authenticate(token);

const [authRef] = await db.query("RETURN $auth;");
```

In this flow, `$auth` resolves to the authenticated record reference, and `SELECT * FROM ONLY $auth` returns the full user record.

## Browser Tests

This repo keeps browser-focused checks separate from the main node/integration suite.

Run them with:

```bash
  bun run test:browser:setup
  bun run test:browser
```

The first command installs the local Playwright browser binary used by `@vitest/browser-playwright`. You only need to run it again when Playwright updates or the cached browser is removed.

If Chromium is already installed for Playwright, you can run just:

```bash
bun run test:browser
```

Current browser coverage focuses on:

- fetching `/.well-known` from a real browser context
- sign-up and sign-in requests from a real browser context
- session cookie reuse via `/api/auth/get-session`

The browser suite starts the example Bun server automatically and proxies `/api/auth/*` through the Vitest browser server so requests stay same-origin for cookie testing.

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
npm run build
npm run test
```

Note: Integration tests require a local SurrealDB instance reachable at `ws://localhost:8000/rpc`, accessed through the current SurrealDB JavaScript SDK v2 client and credentials used in the test helpers.

Test DB scope can be configured with:

- `SURREALDB_TEST_NAMESPACE` (default: `main`)
- `SURREALDB_TEST_DATABASE` (default: `main`)
- `SURREALDB_TEST_ISOLATE=1` to append worker ids for parallel isolation

## TODO

- Decide whether internal `DEFINE API` test support should remain in the public package surface at all.
- Expand transaction coverage to mixed Better Auth plugin flows that perform multiple model writes in one callback.
