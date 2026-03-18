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
- SurrealDB-native UUIDv7 and ULID support
- Rejects bare ids and wrong-table references
- Better Auth transaction support via SurrealDB session transactions
- Schema generation support with optional `defineAccess` for fine-grained access control

## Adapter options

- `debugLogs?: boolean`
- `recordIdFormat?: "native" | "ulid" | "uuidv7" | (({ model }) => ...)`
- `transaction?: boolean`
- `defineAccess?: () => BoundQuery`
