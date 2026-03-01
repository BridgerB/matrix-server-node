import type { UserId, AccessToken, RefreshToken, Timestamp } from "../types/index.ts";
import type { UserAccount } from "../types/index.ts";
import type { Storage, StoredSession } from "./interface.ts";

export class MemoryStorage implements Storage {
  private users = new Map<string, UserAccount>();
  private usersByFullId = new Map<UserId, UserAccount>();
  private sessions = new Map<AccessToken, StoredSession>();
  private refreshIndex = new Map<RefreshToken, AccessToken>();
  private uiaaSessions = new Map<string, { completed: string[] }>();

  // Users

  async createUser(account: UserAccount): Promise<void> {
    this.users.set(account.localpart, account);
    this.usersByFullId.set(account.user_id, account);
  }

  async getUserByLocalpart(localpart: string): Promise<UserAccount | undefined> {
    return this.users.get(localpart);
  }

  async getUserById(userId: UserId): Promise<UserAccount | undefined> {
    return this.usersByFullId.get(userId);
  }

  // Sessions

  async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.access_token, session);
    if (session.refresh_token) {
      this.refreshIndex.set(session.refresh_token, session.access_token);
    }
  }

  async getSessionByAccessToken(token: AccessToken): Promise<StoredSession | undefined> {
    return this.sessions.get(token);
  }

  async getSessionByRefreshToken(token: RefreshToken): Promise<StoredSession | undefined> {
    const accessToken = this.refreshIndex.get(token);
    if (!accessToken) return undefined;
    return this.sessions.get(accessToken);
  }

  async getSessionsByUser(userId: UserId): Promise<StoredSession[]> {
    const result: StoredSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.user_id === userId) result.push(session);
    }
    return result;
  }

  async deleteSession(token: AccessToken): Promise<void> {
    const session = this.sessions.get(token);
    if (session?.refresh_token) {
      this.refreshIndex.delete(session.refresh_token);
    }
    this.sessions.delete(token);
  }

  async deleteAllSessions(userId: UserId): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.user_id === userId) {
        if (session.refresh_token) {
          this.refreshIndex.delete(session.refresh_token);
        }
        this.sessions.delete(token);
      }
    }
  }

  async rotateToken(
    oldAccessToken: AccessToken,
    newAccessToken: AccessToken,
    newRefreshToken?: RefreshToken,
    expiresAt?: Timestamp,
  ): Promise<StoredSession | undefined> {
    const session = this.sessions.get(oldAccessToken);
    if (!session) return undefined;

    this.sessions.delete(oldAccessToken);
    if (session.refresh_token) {
      this.refreshIndex.delete(session.refresh_token);
    }

    const updated: StoredSession = {
      ...session,
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_at: expiresAt,
    };

    this.sessions.set(newAccessToken, updated);
    if (newRefreshToken) {
      this.refreshIndex.set(newRefreshToken, newAccessToken);
    }
    return updated;
  }

  async touchSession(token: AccessToken, ip: string, userAgent: string): Promise<void> {
    const session = this.sessions.get(token);
    if (session) {
      session.last_seen_ip = ip;
      session.last_seen_ts = Date.now();
      session.user_agent = userAgent;
    }
  }

  // UIAA

  async createUIAASession(sessionId: string): Promise<void> {
    this.uiaaSessions.set(sessionId, { completed: [] });
  }

  async getUIAASession(sessionId: string): Promise<{ completed: string[] } | undefined> {
    return this.uiaaSessions.get(sessionId);
  }

  async addUIAACompleted(sessionId: string, stageType: string): Promise<void> {
    const session = this.uiaaSessions.get(sessionId);
    if (session) {
      session.completed.push(stageType);
    }
  }

  async deleteUIAASession(sessionId: string): Promise<void> {
    this.uiaaSessions.delete(sessionId);
  }
}
