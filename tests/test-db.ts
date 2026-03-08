import { Surreal } from "surrealdb";

export async function createTestDb() {
  try {
    const db = new Surreal();
    await db.connect("ws://localhost:8000/rpc");
    await db.signin({ username: "root", password: "root" });
    await db.use({ namespace: "main", database: "main" });

    return { db };
  } catch (error) {
    console.error("Failed to connect to SurrealDB:", error);
    throw error;
  }
}
