export type UserSeed = {
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
};

let seedCounter = 0;

function nextSuffix() {
  seedCounter += 1;
  return `${Date.now()}_${seedCounter}`;
}

export function makeUserSeed(overrides?: Partial<UserSeed>): UserSeed {
  const suffix = nextSuffix();
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
