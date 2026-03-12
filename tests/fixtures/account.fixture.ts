export type AccountSeed = {
  accountId: string;
  providerId: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  scope?: string | null;
  password?: string | null;
};

let accountSeedCounter = 0;

function nextAccountSuffix() {
  accountSeedCounter += 1;
  return `${Date.now()}_${accountSeedCounter}`;
}

export function makeAccountSeed(overrides?: Partial<AccountSeed>): AccountSeed {
  const suffix = nextAccountSuffix();
  const now = new Date();

  return {
    accountId: `account_${suffix}`,
    providerId: `provider_${suffix}`,
    userId: `user_${suffix}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
