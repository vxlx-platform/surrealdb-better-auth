import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Surreal } from "surrealdb";

import { applySurqlSchema, surrealAdapter } from "../src/index";

const port = Number(process.env.PORT ?? 3000);
const endpoint = process.env.SURREALDB_ENDPOINT ?? "ws://localhost:8000/rpc";
const username = process.env.SURREALDB_USERNAME ?? "root";
const password = process.env.SURREALDB_PASSWORD ?? "root";
const namespace = process.env.SURREALDB_NAMESPACE ?? "main";
const database = process.env.SURREALDB_DATABASE ?? "main";
const baseURL = process.env.BETTER_AUTH_BASE_URL ?? `http://127.0.0.1:${port}`;
const jwtAlg = (process.env.JWT_ALG ?? "RS256") as "EdDSA" | "ES256" | "ES512" | "RS256" | "PS256";
const jwtJwksPath = process.env.JWT_JWKS_PATH ?? "/.well-known";
const accessName = process.env.SURREALDB_ACCESS;
const jwksUrl = new URL(`/api/auth${jwtJwksPath}`, baseURL).toString();

const db = new Surreal();
await db.connect(endpoint);
await db.signin({
  username,
  password,
});
await db.use({
  namespace,
  database,
});

const auth = betterAuth({
  baseURL,
  database: surrealAdapter(db),
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
        keyPairConfig: {
          alg: jwtAlg,
          ...(jwtAlg.startsWith("RS") ? { modulusLength: 2048 } : {}),
        },
        jwksPath: jwtJwksPath,
      },
      jwt: {
        issuer: baseURL,
        audience: baseURL,
        definePayload: ({ user }) => {
          return {
            id: accessName ? `user:${user.id}` : user.id,
            email: user.email,
            emailVerified: user.emailVerified,
            ...(accessName
              ? {
                  ns: namespace,
                  db: database,
                  ac: accessName,
                }
              : {}),
          };
        },
        getSubject: (session) => (accessName ? `user:${session.user.id}` : session.user.id),
      },
    }),
  ],
});

await applySurqlSchema({
  db,
  authOptions: auth.options,
  file: "better-auth-schema.surql",
});

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
        surrealApiBase: `/api/${namespace}/${database}`,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

const shutdown = async () => {
  void server.stop(true);
  await db.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Better Auth dev server running at http://localhost:${server.port}`);
console.log(`JWKS route: ${jwksUrl}`);
