const fixtureCounters = new Map<string, number>();

export function nextFixtureSuffix(scope: string): string {
  const next = (fixtureCounters.get(scope) ?? 0) + 1;
  fixtureCounters.set(scope, next);
  return `${Date.now()}_${next}`;
}
