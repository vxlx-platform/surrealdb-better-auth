# @vxlx/surrealdb-better-auth

SurrealDB-first [Better Auth](https://www.better-auth.com/) adapter built for the SurrealDB JavaScript SDK v2.

It uses SurrealDB string record ids (`table:id`) and record links as the adapter contract.

- npm: [`@vxlx/surrealdb-better-auth`](https://www.npmjs.com/package/@vxlx/surrealdb-better-auth)
- repository: [vxlx-platform/surrealdb-better-auth](https://github.com/vxlx-platform/surrealdb-better-auth)

## Why this adapter

If you're using Better Auth with the SurrealDB JavaScript SDK, this adapter gives you a SurrealDB-native integration layer instead of forcing a SQL-shaped adapter model onto SurrealDB.

- SurrealDB record-id-first identity model
- Full string record ids at the adapter boundary
- Automatic `RecordId` handling for references
- Better Auth adapter factory and transaction support
- Built for modern SurrealDB deployments

## What Makes This Adapter Different

Compared with more generic or SQL-shaped SurrealDB adapters, this adapter is opinionated about staying close to both SurrealDB and Better Auth.

- Uses the SurrealDB record id as the real primary identity instead of treating `id` as just another stored column.
- Keeps ids as full SurrealDB string record ids (`table:id`) in adapter output.
- Converts accepted id inputs (`RecordId`, `StringRecordId`, or `table:id`) into SurrealDB `RecordId` links, while rejecting bare ids and wrong-table record ids early.
- Uses database-side sorting, pagination, and filtering instead of falling back to JavaScript-side query shaping.
- Rejects unsupported query operators explicitly instead of silently degrading behavior.
- Supports Better Auth transactions through SurrealDB session transactions.
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

Version note:

- JavaScript SDK: `surrealdb` package v2
- SurrealDB: modern v3 deployments

## Requirements

- A connected/authenticated SurrealDB JavaScript SDK v2 client
- Better Auth configured to not generate DB ids

## Better Auth Environment Variables

For Better Auth apps, prefer setting:

- `BETTER_AUTH_SECRET` (minimum 32 chars)
- `BETTER_AUTH_URL` (for example `https://example.com`)

When these are set, you can omit `secret` and `baseURL` in `betterAuth({...})`.
If they are not set, define `secret` and `baseURL` explicitly in config.

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
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
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

The adapter accepts the `Surreal` client directly and uses SDK-native types such as `RecordId` for id and relation handling internally.

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

The adapter supports Better Auth's transaction hook using the SurrealDB session transaction API.

Current behavior:

- `transaction: true`/unset (default): use transactions when the connected client reports support for `Features.Transactions`.
- `transaction: false`: disable transaction-backed adapter hooks.
- If a transaction callback throws, the adapter cancels and rethrows the original error.

## Schema Generation

The adapter implements Better Auth's `createSchema` hook, so Better Auth CLI `generate` can emit SurrealQL using your auth config.

This package currently exports only the runtime adapter entrypoint. It does not expose standalone schema helper exports or an adapter-specific migration CLI.

After adding or changing Better Auth plugins (or plugin-managed fields/tables), regenerate and apply updated schema before running the app.

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

## Exported API

- `surrealAdapter(db, config?)`
- `SurrealAdapterConfig`

## Development

```bash
bun run build
bun run test
```

Useful test commands:

- `bun run test` / `bun run test:unit` -> unit tests
- `bun run test:integration` -> integration tests
- `bun run test:all` -> full test suite

Note: Live integration tests require a local SurrealDB instance reachable at `ws://localhost:8000/rpc`, using the same client credentials configured in test helpers.

Live test DB scope can be configured with:

- `SURREALDB_TEST_ENDPOINT` (default: `ws://localhost:8000/rpc`)
- `SURREALDB_TEST_USERNAME` (default: `root`)
- `SURREALDB_TEST_PASSWORD` (default: `root`)
- `SURREALDB_TEST_NAMESPACE` (default: `main`)
- `SURREALDB_TEST_DATABASE` (default: `main`)
- `SURREALDB_TEST_ISOLATE=1` to append worker ids for parallel isolation
