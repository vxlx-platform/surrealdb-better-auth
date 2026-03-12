import { nextFixtureSuffix } from "./seed.fixture";

export type VerificationSeed = {
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export function makeVerificationSeed(overrides?: Partial<VerificationSeed>): VerificationSeed {
  const suffix = nextFixtureSuffix("verification");
  const now = new Date();

  return {
    identifier: `verification_${suffix}`,
    value: `value_${suffix}`,
    expiresAt: new Date(now.getTime() + 1000 * 60 * 15),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeResetPasswordIdentifier(token: string): string {
  return `reset-password:${token}`;
}
