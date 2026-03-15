import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type AuthHandler = {
  handler: (request: Request) => Promise<Response>;
};

export type RunningTestServer = {
  origin: string;
  url: (path: string) => string;
  stop: () => Promise<void>;
};

const sleep = async (ms: number) => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

const waitForHealth = async (origin: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Server startup race; retry.
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for test server health check at ${origin}/health`);
};

const toRequest = async (origin: string, request: IncomingMessage) => {
  const url = new URL(request.url ?? "/", origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body });
};

const writeResponse = async (nodeResponse: ServerResponse, response: Response) => {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;

  const responseHeaders = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = responseHeaders.getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    nodeResponse.setHeader("set-cookie", setCookies);
  }
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    nodeResponse.setHeader(key, value);
  }

  const body = await response.arrayBuffer();
  nodeResponse.end(Buffer.from(body));
};

export const startTestServer = async (auth: AuthHandler): Promise<RunningTestServer> => {
  const server = createServer(async (request, response) => {
    try {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const webRequest = await toRequest(origin, request);
      const { pathname } = new URL(webRequest.url);

      if (pathname === "/health") {
        await writeResponse(response, Response.json({ status: "ok" }));
        return;
      }

      if (pathname.startsWith("/api/auth/")) {
        const authResponse = await auth.handler(webRequest);
        await writeResponse(response, authResponse);
        return;
      }

      await writeResponse(response, new Response("Not Found", { status: 404 }));
    } catch {
      response.statusCode = 500;
      response.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address.");
  }
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  await waitForHealth(origin);

  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
};
