export type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AccountRow = {
  id: string;
  userId: string;
  accountId: string;
  id_token?: string | null;
  password: string;
  provider: string;
  providerAccountId: string;
  refresh_token?: string | null;
  refresh_token_expires_at?: number | null;
  access_token?: string | null;
  access_token_expires_at?: number | null;
  token_type?: string | null;
  scope?: string | null;
  session_state?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionRow = {
  id: string;
  userId: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type VerificationRow = {
  id: string;
  userId: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type JWKSRow = {
  id: string;
  privateKey: string;
  publicKey: string;
  createdAt: Date;
};
