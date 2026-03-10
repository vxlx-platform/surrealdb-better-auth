import { spawn, type ChildProcess } from "node:child_process";

import { getScopedDbName, getTestDbEnv } from "./env";

export interface TestServerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

const waitForHealth = async (baseUrl: string, timeoutMs: number) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for test server health check at ${baseUrl}/health`);
};

export async function startTestServer(port = 3001): Promise<TestServerHandle> {
  const env = getTestDbEnv();
  const child: ChildProcess = spawn("bun", ["run", "./examples/bun-server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SURREALDB_ENDPOINT: env.endpoint,
      SURREALDB_USERNAME: env.username,
      SURREALDB_PASSWORD: env.password,
      SURREALDB_NAMESPACE: getScopedDbName(env.namespace),
      SURREALDB_DATABASE: getScopedDbName(env.database),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl, 15_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`,
    );
  }

  return {
    baseUrl,
    stop: async () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 1_000);

        child.once("exit", () => {
          clearTimeout(forceKillTimer);
          resolve();
        });

        setTimeout(() => {
          clearTimeout(forceKillTimer);
          resolve();
        }, 2_000);
      });
    },
  };
}
