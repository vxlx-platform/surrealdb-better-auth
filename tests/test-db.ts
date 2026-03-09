import { Surreal } from "surrealdb";

function getTestDbScope() {
  const fixedNamespace = process.env.SURREALDB_TEST_NAMESPACE ?? "main";
  const fixedDatabase = process.env.SURREALDB_TEST_DATABASE ?? "main";
  const isolate = process.env.SURREALDB_TEST_ISOLATE === "1";

  if (!isolate) {
    return {
      namespace: fixedNamespace,
      database: fixedDatabase,
    };
  }

  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "local";
  return {
    namespace: `${fixedNamespace}_${workerId}`,
    database: `${fixedDatabase}_${workerId}`,
  };
}

export async function createTestDb() {
  try {
    const db = new Surreal();
    const { namespace, database } = getTestDbScope();
    await db.connect("ws://localhost:8000/rpc");
    await db.signin({ username: "root", password: "root" });
    await db.use({ namespace, database });

    return { db };
  } catch (error) {
    console.error("Failed to connect to SurrealDB:", error);
    throw error;
  }
}
