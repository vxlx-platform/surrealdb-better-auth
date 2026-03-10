export interface TestDbEnv {
  endpoint: string;
  username: string;
  password: string;
  namespace: string;
  database: string;
  isolate: boolean;
}

export function getTestDbEnv(): TestDbEnv {
  return {
    endpoint: process.env.SURREALDB_TEST_ENDPOINT ?? "ws://localhost:8000/rpc",
    username: process.env.SURREALDB_TEST_USERNAME ?? "root",
    password: process.env.SURREALDB_TEST_PASSWORD ?? "root",
    namespace: process.env.SURREALDB_TEST_NAMESPACE ?? "main",
    database: process.env.SURREALDB_TEST_DATABASE ?? "main",
    isolate: process.env.SURREALDB_TEST_ISOLATE === "1",
  };
}

export function getScopedDbName(base: string): string {
  const env = getTestDbEnv();
  if (!env.isolate) return base;

  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "local";
  return `${base}_${workerId}`;
}

export function getHttpApiBaseUrl(): string {
  const env = getTestDbEnv();
  const url = new URL(env.endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/api/${getScopedDbName(env.namespace)}/${getScopedDbName(env.database)}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function getBasicAuthHeader(): string {
  const env = getTestDbEnv();
  return `Basic ${Buffer.from(`${env.username}:${env.password}`).toString("base64")}`;
}

export function getSurrealHttpHeaders(): Record<string, string> {
  const env = getTestDbEnv();
  return {
    authorization: getBasicAuthHeader(),
    accept: "application/json",
    "surreal-ns": getScopedDbName(env.namespace),
    "surreal-db": getScopedDbName(env.database),
  };
}
