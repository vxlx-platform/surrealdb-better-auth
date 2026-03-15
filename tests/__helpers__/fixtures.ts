const nextId = (() => {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
})();

const token = (prefix: string) => `${prefix}-${Date.now()}-${nextId()}`;

export const uniqueEmail = (prefix: string) => `${token(prefix)}@example.com`;

export type UserSeed = {
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

export const buildUserSeed = (overrides: Partial<UserSeed> = {}): UserSeed => {
  const now = new Date();
  return {
    name: "Test User",
    email: uniqueEmail("user"),
    emailVerified: false,
    image: undefined,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

export type SessionSeed = {
  token: string;
  expiresAt: Date;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
};

export const buildSessionSeed = (overrides: Partial<SessionSeed> = {}): SessionSeed => {
  const now = new Date();
  return {
    token: token("session"),
    expiresAt: new Date(now.getTime() + 1000 * 60 * 60),
    ipAddress: undefined,
    userAgent: undefined,
    userId: "user:seed_user",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

export type AccountSeed = {
  accountId: string;
  providerId: string;
  userId: string;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  idToken?: string | undefined;
  accessTokenExpiresAt?: Date | undefined;
  refreshTokenExpiresAt?: Date | undefined;
  scope?: string | undefined;
  password?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

export const buildAccountSeed = (overrides: Partial<AccountSeed> = {}): AccountSeed => {
  const now = new Date();
  return {
    accountId: token("account"),
    providerId: token("provider"),
    userId: "user:seed_user",
    accessToken: undefined,
    refreshToken: undefined,
    idToken: undefined,
    accessTokenExpiresAt: undefined,
    refreshTokenExpiresAt: undefined,
    scope: undefined,
    password: undefined,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

export type VerificationSeed = {
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const buildVerificationSeed = (
  overrides: Partial<VerificationSeed> = {},
): VerificationSeed => {
  const now = new Date();
  return {
    identifier: token("verification"),
    value: token("value"),
    expiresAt: new Date(now.getTime() + 1000 * 60 * 60),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};
