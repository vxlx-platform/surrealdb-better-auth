import type { Surreal } from "surrealdb";

export const AUTH_TABLES = ["session", "account", "verification", "user", "jwks"] as const;

export async function truncateTables(db: Surreal, tables: readonly string[]) {
  for (const table of tables) {
    try {
      await db.query(`DELETE ${table}`);
    } catch {
      // Ignore missing table errors when schema has not been applied yet.
    }
  }
}

