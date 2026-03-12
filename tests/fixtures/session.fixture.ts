export type SessionSeed = {
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

let sessionSeedCounter = 0;

function nextSessionSuffix() {
  sessionSeedCounter += 1;
  return `${Date.now()}_${sessionSeedCounter}`;
}

export function makeSessionSeed(overrides?: Partial<SessionSeed>): SessionSeed {
  const suffix = nextSessionSuffix();
  const now = new Date();

  return {
    token: `session_${suffix}`,
    userId: `user_${suffix}`,
    expiresAt: new Date(now.getTime() + 1000 * 60 * 60),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
    ...overrides,
  };
}
