import { nextFixtureSuffix } from "./seed.fixture";

export type UserSeed = {
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function makeUserSeed(overrides?: Partial<UserSeed>): UserSeed {
  const suffix = nextFixtureSuffix("user");
  const now = new Date();

  return {
    name: `Test User ${suffix}`,
    email: `test.user.${suffix}@example.com`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
