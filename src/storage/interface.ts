import type { UserId, AccessToken, RefreshToken, Timestamp } from "../types/index.ts";
import type { UserAccount, DeviceSession } from "../types/index.ts";

export interface StoredSession extends DeviceSession {
  access_token: AccessToken;
  refresh_token?: RefreshToken;
  expires_at?: Timestamp;
}

export interface Storage {
  // Users
  createUser(account: UserAccount): Promise<void>;
  getUserByLocalpart(localpart: string): Promise<UserAccount | undefined>;
  getUserById(userId: UserId): Promise<UserAccount | undefined>;

  // Sessions / Devices
  createSession(session: StoredSession): Promise<void>;
  getSessionByAccessToken(token: AccessToken): Promise<StoredSession | undefined>;
  getSessionByRefreshToken(token: RefreshToken): Promise<StoredSession | undefined>;
  getSessionsByUser(userId: UserId): Promise<StoredSession[]>;
  deleteSession(token: AccessToken): Promise<void>;
  deleteAllSessions(userId: UserId): Promise<void>;
  rotateToken(oldAccessToken: AccessToken, newAccessToken: AccessToken, newRefreshToken?: RefreshToken, expiresAt?: Timestamp): Promise<StoredSession | undefined>;
  touchSession(token: AccessToken, ip: string, userAgent: string): Promise<void>;

  // UIAA Sessions
  createUIAASession(sessionId: string): Promise<void>;
  getUIAASession(sessionId: string): Promise<{ completed: string[] } | undefined>;
  addUIAACompleted(sessionId: string, stageType: string): Promise<void>;
  deleteUIAASession(sessionId: string): Promise<void>;
}
