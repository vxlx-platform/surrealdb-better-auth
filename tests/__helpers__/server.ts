import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { getScopedDbName, getTestDbEnv } from "./env";

export interface TestServerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartTestServerOptions {
  port?: number;
  env?: Record<string, string>;
}

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_START_ATTEMPTS = 4;

const isPortAvailable = async (port: number): Promise<boolean> => {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
};

const pickAvailablePort = async (basePort: number, maxAttempts = 20): Promise<number> => {
  for (let offset = 0; offset <= maxAttempts; offset++) {
    const candidate = basePort + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find an available test server port near ${basePort}.`);
};

const waitForHealth = async (baseUrl: string, child: ChildProcess, timeoutMs: number) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `Test server exited early with code ${child.exitCode} while waiting for health check at ${baseUrl}/health`,
      );
    }

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

const stopChildProcess = async (child: ChildProcess) => {
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
};

const createAttemptError = ({
  attempt,
  baseUrl,
  error,
  stdout,
  stderr,
}: {
  attempt: number;
  baseUrl: string;
  error: unknown;
  stdout: string;
  stderr: string;
}) => {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Failed to start test server (attempt ${attempt}) at ${baseUrl}: ${reason}${
      output ? `\n${output}` : ""
    }`,
  );
};

const isRetriableStartupFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("EADDRINUSE") ||
    message.includes("address already in use") ||
    message.includes("exited early")
  );
};

export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServerHandle> {
  const env = getTestDbEnv();
  const rawWorkerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
  const workerId = rawWorkerId ? Number(rawWorkerId) : 0;
  const workerPortBase = (options.port ?? 3001) + workerId * 100;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    const preferredPort = options.port ?? workerPortBase + (attempt - 1) * 10;
    const port = options.port
      ? preferredPort
      : await pickAvailablePort(preferredPort, 50);

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
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      spawnError = error;
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      if (spawnError) {
        throw spawnError;
      }
      await waitForHealth(baseUrl, child, STARTUP_TIMEOUT_MS);
      return {
        baseUrl,
        stop: async () => {
          await stopChildProcess(child);
        },
      };
    } catch (error) {
      await stopChildProcess(child);
      const attemptError = createAttemptError({
        attempt,
        baseUrl,
        error,
        stdout,
        stderr,
      });
      lastError = attemptError;

      if (!options.port && isRetriableStartupFailure(attemptError) && attempt < MAX_START_ATTEMPTS) {
        continue;
      }

      throw attemptError;
    }
  }

  throw lastError ?? new Error("Failed to start test server for an unknown reason.");
}
