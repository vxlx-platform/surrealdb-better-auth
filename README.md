# @vxlx/surrealdb-better-auth

SurrealDB-first [Better Auth](https://www.better-auth.com/) adapter built for the SurrealDB JavaScript SDK v2.

It uses SurrealDB string record ids (`table:id`) and record links as the adapter contract.

- npm: [`@vxlx/surrealdb-better-auth`](https://www.npmjs.com/package/@vxlx/surrealdb-better-auth)
- repository: [vxlx-platform/surrealdb-better-auth](https://github.com/vxlx-platform/surrealdb-better-auth)

## Why this adapter

If you're using Better Auth with the SurrealDB JavaScript SDK v2 client, this adapter gives you a SurrealDB-native integration layer instead of forcing a SQL-shaped adapter model onto SurrealDB.

- SurrealDB record-id-first identity model
- Full string record ids at the adapter boundary
- Automatic `RecordId` handling for references
- Better Auth adapter factory and transaction support
- Built for the SurrealDB JavaScript SDK v2 on modern SurrealDB deployments

## What Makes This Adapter Different

Compared with more generic or SQL-shaped SurrealDB adapters, this adapter is opinionated about staying close to both SurrealDB and Better Auth.

- Uses the SurrealDB record id as the real primary identity instead of treating `id` as just another stored column.
- Keeps ids as full SurrealDB string record ids (`table:id`) in adapter output.
- Converts accepted id inputs (`RecordId`, `StringRecordId`, or `table:id`) into SurrealDB `RecordId` links, while rejecting bare ids and wrong-table record ids early.
- Uses database-side sorting, pagination, and filtering instead of falling back to JavaScript-side query shaping.
- Rejects unsupported query operators explicitly instead of silently degrading behavior.
- Supports Better Auth transactions through SurrealDB SDK v2 session transactions.
- Generates SurrealDB-oriented schema with `record<...>` reference fields instead of modeling auth tables like a relational schema first.
- Shapes common SurrealDB failures into clearer adapter-scoped errors, including unique constraint and field coercion failures.

In short: this adapter keeps Better Auth and SurrealDB aligned on one id contract: string record ids.

## Features

- SurrealDB-first Better Auth adapter built around record ids and record links
- Full CRUD support (`create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`)
- Better Auth transaction support via `adapter.transaction(...)`
- Strict record-id input/output contract (`table:id`)
- Explicit query/operator validation and adapter-scoped error shaping
- Configurable record id generation strategy:
  - `native` (default)
  - `ulid`
  - `uuidv7`
  - per-table function
- Schema generation helper for Better Auth tables (`createSchema` / `generateSurqlSchema`)

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

The adapter currently implements the following `where` operators internally for Better Auth database queries:

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

Unsupported operators are rejected explicitly instead of silently falling back to equality.

For the `in` operator, Better Auth validates that the value is an array before the adapter runs.

When you filter by related records, the adapter accepts `RecordId`, `StringRecordId`, and `table:id` strings. Bare ids are rejected.

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
import { surrealAdapter } from "@vxlx/surrealdb-better-auth";
import { surql } from "surrealdb";

const config = {
  usePlural: false,
  debugLogs: false,
  recordIdFormat: "native", // "native" | "ulid" | "uuidv7" | (tableName) => ...
  transaction: true, // default behavior; set false to disable
  defineAccess: () => surql`
    DEFINE ACCESS OVERWRITE better_auth_user ON DATABASE
      TYPE RECORD
      WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known/jwks.json"
      AUTHENTICATE {
        IF $auth.id { RETURN $auth.id }
        ELSE IF $token.email { RETURN (SELECT VALUE id FROM user WHERE email = $token.email LIMIT 1)[0] }
      }
      DURATION FOR TOKEN 1h, FOR SESSION 24h;
  `,
} as const;

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

`recordIdFormat` affects how new records are created when no explicit id is provided. It does not rewrite explicit ids passed to adapter operations.

### `transaction`

Controls how the adapter handles Better Auth transaction hooks:

- `true`/unset (default): use SDK session transactions when supported by the connected SurrealDB engine, otherwise fallback to Better Auth's non-transaction path.
- `false`: disable database-backed transactions.

```ts
surrealAdapter(db, { transaction: false });
```

### `defineAccess`

Use `defineAccess` when you need full control over emitted `DEFINE ACCESS` SurQL.

```ts
import { surql } from "surrealdb";

surrealAdapter(db, {
  defineAccess: () => surql`
    DEFINE ACCESS OVERWRITE better_auth_user ON DATABASE
      TYPE RECORD
      WITH JWT URL "http://127.0.0.1:3000/api/auth/.well-known/jwks.json"
      AUTHENTICATE {
        IF $auth.id { RETURN $auth.id }
        ELSE IF $token.email { RETURN (SELECT VALUE id FROM user WHERE email = $token.email LIMIT 1)[0] }
      }
      DURATION FOR TOKEN 1h, FOR SESSION 24h;
  `,
});
```

Behavior:

- If `defineAccess` is set, `createSchema` emits that statement.
- If `defineAccess` is omitted, no `DEFINE ACCESS` statement is emitted.
- `defineAccess` must return a SurrealDB `BoundQuery` (for example via `surql\`...\``).
- `defineAccess` queries must not contain bindings in schema generation.
  For dynamic values, inline them with `raw(...)` instead of `${value}` interpolation.

## ID / Reference Behavior

- Adapter outputs always return full string record ids (for `id` and reference fields), for example `user:abc123`.
- ID-bearing inputs must be one of:
  - `RecordId`
  - `StringRecordId`
  - string record id in `table:id` format
- Bare ids like `abc123` are rejected for primary-id and reference-id paths.
- Reference ids must match the referenced table (for example `userId` must be a `user:*` record id).

This keeps id behavior explicit and consistent across Better Auth and SurrealDB.

## Error Handling

The adapter prefers SurrealDB SDK-defined errors where possible and then adds adapter-scoped context for common failures.

Current behavior includes clearer handling for:

- connection/session/setup failures from the SurrealDB SDK
- unique constraint violations
- invalid reference-field values and field coercion failures

Malformed `where` input that Better Auth validates itself, such as a non-array value for the `in` operator, will still fail at the Better Auth layer before the adapter runs.

## Transactions

The adapter supports Better Auth's transaction hook using the SurrealDB JavaScript SDK v2 session transaction API.

This is mainly used by Better Auth itself for multi-step database writes that should succeed or fail atomically.

If a transaction callback throws, the adapter cancels the transaction and rethrows the original error.

### Why unsupported engines can happen

SurrealDB transactions are a core feature, but runtime support can still vary by engine/protocol/version/deployment configuration. In practice, a client can expose transaction methods while the active connection rejects session-backed transaction use.

### How this adapter handles it

By default (`transaction: "auto"`), the adapter checks SDK feature support first:

```ts
db.isFeatureSupported(Features.Sessions) && db.isFeatureSupported(Features.Transactions);
```

If those features are not available, it falls back internally to Better Auth's non-transaction execution path. It also keeps runtime guards around transaction startup to handle engines that still throw `UnsupportedFeatureError` at call time.

## Schema Generation

The adapter supports two explicit schema workflows:

- generate schema only
- apply schema as a migration/setup step

### Better Auth CLI generate

The adapter implements Better Auth's `createSchema` hook, so it is compatible with the Better Auth CLI schema generation flow.

In practice, that means the Better Auth `generate` command can ask the adapter for the SurrealDB schema output instead of requiring a separate adapter-specific generator.

If your Better Auth config module loads cleanly in the CLI environment, you can use the Better Auth CLI generate flow and have it emit SurQL through this adapter's schema hook.

Recommended pattern:

- export a side-effect-free Better Auth config module
- create the `Surreal` client at module scope
- do not call `connect`, `signin`, or `use` during module import
- connect the database in your server/bootstrap entrypoint instead

Example:

```ts
// db.ts
import { Surreal } from "surrealdb";

export const db = new Surreal();

let ready: Promise<void> | null = null;

export function ensureDbReady() {
  if (!ready) {
    ready = (async () => {
      await db.connect(process.env.SURREALDB_ENDPOINT ?? "ws://127.0.0.1:8000/rpc");
      await db.signin({
        username: process.env.SURREALDB_USERNAME ?? "root",
        password: process.env.SURREALDB_PASSWORD ?? "root",
      });
      await db.use({
        namespace: process.env.SURREALDB_NAMESPACE ?? "main",
        database: process.env.SURREALDB_DATABASE ?? "main",
      });
    })();
  }

  return ready;
}
```

```ts
// auth.ts
import { betterAuth } from "better-auth";
import { surrealAdapter } from "@vxlx/surrealdb-better-auth";
import { db } from "./db";

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

```ts
// server.ts
import { auth } from "./auth";
import { ensureDbReady } from "./db";

await ensureDbReady();

Bun.serve({
  port: 3000,
  fetch(request) {
    return auth.handler(request);
  },
});
```

With that shape, `bunx auth@latest generate` can import your Better Auth config and call the adapter's schema hook without requiring a live database connection during module load.

### Generate only

You can generate SurQL through the Better Auth CLI flow or with the standalone generator helper.

```ts
import { generateSurqlSchema } from "@vxlx/surrealdb-better-auth/schema";

const result = await generateSurqlSchema({
  file: "better-auth-schema.ts",
  tables,
  getModelName,
  getFieldName,
});

// result.path -> "better-auth-schema.surql"
// result.code -> SurQL
```

### Apply as a migration or setup step

`applySurqlSchema(...)` is intended for explicit schema application in a migration script, local setup script, or controlled bootstrap step. It is not part of normal request-time adapter usage.

```ts
import { applySurqlSchema } from "@vxlx/surrealdb-better-auth/schema";

await applySurqlSchema({
  db,
  authOptions: auth.options,
  file: "better-auth-schema.surql",
});
```

Internally, `applySurqlSchema(...)` generates the schema through the adapter hook and then applies the SurQL statement-by-statement so repeated runs remain idempotent and do not abort on earlier `DEFINE TABLE ... already exists` errors.

### Migration CLI

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

If you want SurrealDB to accept Better Auth JWTs directly, define a record access method that trusts your Better Auth JWKS endpoint.

You can either:

- emit it from `createSchema` via `defineAccess`, or
- define it manually:

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

## Exported API

- `surrealAdapter(db, config?)`
- `@vxlx/surrealdb-better-auth/schema`
  - `generateSurqlSchema(options)`
  - `executeSurqlSchema(db, code)`
  - `applySurqlSchema(options)`
- Schema entry types:
  - `GenerateSurqlSchemaOptions`
  - `ApplySurqlSchemaOptions`

## Development

```bash
bun run build
bun run test
```

By default, `bun run test` runs the live integration suite.  
Use `bun run test:mock` for mocked/non-essential checks (query shaping, error-branch coverage).

Note: Live integration tests require a local SurrealDB instance reachable at `ws://localhost:8000/rpc`, accessed through the current SurrealDB JavaScript SDK v2 client and credentials used in the test helpers.

Live test DB scope can be configured with:

- `SURREALDB_TEST_NAMESPACE` (default: `test`)
- `SURREALDB_TEST_DATABASE` (default: `test`)
- `SURREALDB_TEST_ISOLATE=1` to append worker ids for parallel isolation

## TODO

- Decide whether internal `DEFINE API` test support should remain in the public package surface at all.
- Expand transaction coverage to mixed Better Auth plugin flows that perform multiple model writes in one callback.
