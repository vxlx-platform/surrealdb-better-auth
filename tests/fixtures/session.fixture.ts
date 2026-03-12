import { nextFixtureSuffix } from "./seed.fixture";

export type SessionSeed = {
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function makeSessionSeed(overrides?: Partial<SessionSeed>): SessionSeed {
  const suffix = nextFixtureSuffix("session");
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
