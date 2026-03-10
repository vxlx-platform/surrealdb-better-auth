import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Surreal } from "surrealdb";

import { applySurqlSchema, surrealAdapter } from "../src/index";

const db = new Surreal();
await db.connect(process.env.SURREALDB_ENDPOINT ?? "ws://localhost:8000/rpc");
await db.signin({
  username: process.env.SURREALDB_USERNAME ?? "root",
  password: process.env.SURREALDB_PASSWORD ?? "root",
});
await db.use({
  namespace: process.env.SURREALDB_NAMESPACE ?? "main",
  database: process.env.SURREALDB_DATABASE ?? "main",
});

const auth = betterAuth({
  database: surrealAdapter(db, {
    apiEndpoints: true,
  }),
  advanced: {
    database: {
      generateId: false,
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    jwt({
      jwks: {
        keyPairConfig: { alg: "RS256" },
        jwksPath: "/.well-known",
      },
    }),
  ],
});

await applySurqlSchema({
  db,
  authOptions: auth.options,
  file: "better-auth-schema.surql",
});

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth")) {
      const response = await auth.handler(request);
      if (response) return response;
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        authBase: "/api/auth",
        surrealApiBase: `/api/${process.env.SURREALDB_NAMESPACE ?? "main"}/${process.env.SURREALDB_DATABASE ?? "main"}`,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

const shutdown = async () => {
  server.stop(true);
  await db.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Better Auth dev server running at http://localhost:${server.port}`);
console.log(`JWKS route: http://localhost:${server.port}/api/auth/.well-known`);
