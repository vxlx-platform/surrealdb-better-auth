export const DEFAULT_HTTP_TIMEOUT_MS = 5_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

export function getCookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };

  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      return cookies
        .map((cookie) => cookie.split(";")[0] ?? "")
        .filter(Boolean)
        .join("; ");
    }
  }

  const singleCookie = response.headers.get("set-cookie");
  return singleCookie ? (singleCookie.split(";")[0] ?? "") : "";
}

export async function expectOkJson(response: Response, context: string) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${context} failed with ${response.status} ${response.statusText}: ${body}`);
  }

  return response.json();
}
