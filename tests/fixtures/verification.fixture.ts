export type VerificationSeed = {
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

let verificationSeedCounter = 0;

function nextVerificationSuffix() {
  verificationSeedCounter += 1;
  return `${Date.now()}_${verificationSeedCounter}`;
}

export function makeVerificationSeed(overrides?: Partial<VerificationSeed>): VerificationSeed {
  const suffix = nextVerificationSuffix();
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
