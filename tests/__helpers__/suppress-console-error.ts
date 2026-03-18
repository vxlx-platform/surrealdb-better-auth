import { vi } from "vitest";

type MessageMatcher = RegExp | ((message: string) => boolean);

const toMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toMatchers = (matcher: MessageMatcher | MessageMatcher[]): MessageMatcher[] =>
  Array.isArray(matcher) ? matcher : [matcher];

const matches = (message: string, matcher: MessageMatcher): boolean =>
  typeof matcher === "function" ? matcher(message) : matcher.test(message);

export const withSuppressedConsoleError = async <T>(
  run: () => Promise<T>,
  matcher: MessageMatcher | MessageMatcher[],
): Promise<T> => {
  const original = console.error;
  const matchers = toMatchers(matcher);

  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const message = args.map(toMessage).join(" ");
    const shouldSuppress = matchers.some((entry) => matches(message, entry));
    if (!shouldSuppress) {
      original(...(args as Parameters<typeof console.error>));
    }
  });

  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
};
