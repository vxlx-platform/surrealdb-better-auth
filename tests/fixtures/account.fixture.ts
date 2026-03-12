import { nextFixtureSuffix } from "./seed.fixture";

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

export function makeAccountSeed(overrides?: Partial<AccountSeed>): AccountSeed {
  const suffix = nextFixtureSuffix("account");
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
