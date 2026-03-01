import type { UserId, RoomId, RoomAlias, EventId, DeviceId, AccessToken, RefreshToken, Timestamp, ServerName } from "../types/index.ts";
import type { UserAccount, RoomState } from "../types/index.ts";
import type { PDU, StrippedStateEvent } from "../types/events.ts";
import type { UserProfile, Device } from "../types/user.ts";
import type { Storage, StoredSession } from "./interface.ts";
import { computeEventId } from "../events.ts";

export class MemoryStorage implements Storage {
  private users = new Map<string, UserAccount>();
  private usersByFullId = new Map<UserId, UserAccount>();
  private sessions = new Map<AccessToken, StoredSession>();
  private refreshIndex = new Map<RefreshToken, AccessToken>();
  private uiaaSessions = new Map<string, { completed: string[] }>();
  private rooms = new Map<RoomId, RoomState>();
  private events = new Map<EventId, PDU>();
  private roomTimeline = new Map<RoomId, { eventId: EventId; streamPos: number }[]>();
  private streamCounter = 0;
  private txnMap = new Map<string, EventId>();
  private eventWaiters = new Set<() => void>();
  private aliases = new Map<RoomAlias, { room_id: RoomId; servers: ServerName[]; creator: UserId }>();
  private publicRooms = new Set<RoomId>();

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

  // Rooms

  async createRoom(state: RoomState): Promise<void> {
    this.rooms.set(state.room_id, state);
    this.roomTimeline.set(state.room_id, []);
  }

  async getRoom(roomId: RoomId): Promise<RoomState | undefined> {
    return this.rooms.get(roomId);
  }

  async getRoomsForUser(userId: UserId): Promise<RoomId[]> {
    const result: RoomId[] = [];
    for (const room of this.rooms.values()) {
      const memberEvent = room.state_events.get("m.room.member\0" + userId);
      if (memberEvent) {
        const membership = (memberEvent.content as Record<string, unknown>)["membership"];
        if (membership === "join") result.push(room.room_id);
      }
    }
    return result;
  }

  // Events

  async storeEvent(event: PDU, eventId: EventId): Promise<void> {
    this.events.set(eventId, event);
    const timeline = this.roomTimeline.get(event.room_id);
    if (timeline) {
      this.streamCounter++;
      timeline.push({ eventId, streamPos: this.streamCounter });
    }
    // Wake long-polling sync connections
    for (const waiter of this.eventWaiters) {
      waiter();
    }
  }

  async getEvent(eventId: EventId): Promise<{ event: PDU; eventId: EventId } | undefined> {
    const event = this.events.get(eventId);
    if (!event) return undefined;
    return { event, eventId };
  }

  async getEventsByRoom(
    roomId: RoomId,
    limit: number,
    from?: number,
    direction: "b" | "f" = "f",
  ): Promise<{ events: { event: PDU; eventId: EventId }[]; end?: number }> {
    const timeline = this.roomTimeline.get(roomId) ?? [];
    const fromPos = from ?? (direction === "f" ? 0 : this.streamCounter + 1);

    let filtered: typeof timeline;
    if (direction === "f") {
      filtered = timeline.filter((e) => e.streamPos > fromPos);
    } else {
      filtered = timeline.filter((e) => e.streamPos < fromPos).reverse();
    }

    const sliced = filtered.slice(0, limit);
    const events = sliced.map((e) => ({
      event: this.events.get(e.eventId)!,
      eventId: e.eventId,
    }));

    const lastEntry = sliced[sliced.length - 1];
    const end = lastEntry ? lastEntry.streamPos : undefined;
    return { events, end };
  }

  async getStreamPosition(): Promise<number> {
    return this.streamCounter;
  }

  // State

  async getStateEvent(
    roomId: RoomId,
    eventType: string,
    stateKey: string,
  ): Promise<{ event: PDU; eventId: EventId } | undefined> {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const event = room.state_events.get(eventType + "\0" + stateKey);
    if (!event) return undefined;
    return { event, eventId: computeEventId(event) };
  }

  async getAllState(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const result: { event: PDU; eventId: EventId }[] = [];
    for (const event of room.state_events.values()) {
      result.push({ event, eventId: computeEventId(event) });
    }
    return result;
  }

  async setStateEvent(roomId: RoomId, event: PDU, eventId: EventId): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const key = event.type + "\0" + (event.state_key ?? "");
    room.state_events.set(key, event);
    await this.storeEvent(event, eventId);
  }

  // Members

  async getMemberEvents(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const result: { event: PDU; eventId: EventId }[] = [];
    for (const [key, event] of room.state_events) {
      if (key.startsWith("m.room.member\0")) {
        result.push({ event, eventId: computeEventId(event) });
      }
    }
    return result;
  }

  // Transaction idempotency

  async getTxnEventId(userId: UserId, deviceId: DeviceId, txnId: string): Promise<EventId | undefined> {
    return this.txnMap.get(`${userId}|${deviceId}|${txnId}`);
  }

  async setTxnEventId(userId: UserId, deviceId: DeviceId, txnId: string, eventId: EventId): Promise<void> {
    this.txnMap.set(`${userId}|${deviceId}|${txnId}`, eventId);
  }

  // Sync

  async getRoomsForUserWithMembership(userId: UserId): Promise<{ roomId: RoomId; membership: string }[]> {
    const result: { roomId: RoomId; membership: string }[] = [];
    for (const room of this.rooms.values()) {
      const memberEvent = room.state_events.get("m.room.member\0" + userId);
      if (memberEvent) {
        const membership = (memberEvent.content as Record<string, unknown>)["membership"] as string | undefined;
        if (membership) result.push({ roomId: room.room_id, membership });
      }
    }
    return result;
  }

  async getEventsByRoomSince(
    roomId: RoomId,
    since: number,
    limit: number,
  ): Promise<{ events: { event: PDU; eventId: EventId; streamPos: number }[]; limited: boolean }> {
    const timeline = this.roomTimeline.get(roomId) ?? [];
    const filtered = timeline.filter((e) => e.streamPos > since);
    const limited = filtered.length > limit;
    // When limited, take the most recent events (tail)
    const sliced = limited ? filtered.slice(filtered.length - limit) : filtered;
    const events = sliced.map((e) => ({
      event: this.events.get(e.eventId)!,
      eventId: e.eventId,
      streamPos: e.streamPos,
    }));
    return { events, limited };
  }

  async getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const INVITE_STATE_TYPES = new Set([
      "m.room.create", "m.room.join_rules", "m.room.canonical_alias",
      "m.room.avatar", "m.room.name", "m.room.encryption",
    ]);
    const result: StrippedStateEvent[] = [];
    for (const [key, event] of room.state_events) {
      const type = key.split("\0")[0]!;
      if (INVITE_STATE_TYPES.has(type) || type === "m.room.member") {
        result.push({
          content: event.content,
          sender: event.sender,
          state_key: event.state_key ?? "",
          type: event.type,
        });
      }
    }
    return result;
  }

  async waitForEvents(since: number, timeoutMs: number): Promise<void> {
    if (this.streamCounter > since) return;
    if (timeoutMs <= 0) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.eventWaiters.delete(wake);
        resolve();
      }, timeoutMs);

      const wake = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(wake);
        resolve();
      };

      this.eventWaiters.add(wake);
    });
  }

  // Profile

  async getProfile(userId: UserId): Promise<UserProfile | undefined> {
    const user = this.usersByFullId.get(userId);
    if (!user) return undefined;
    const profile: UserProfile = {};
    if (user.displayname) profile.displayname = user.displayname;
    if (user.avatar_url) profile.avatar_url = user.avatar_url;
    return profile;
  }

  async setDisplayName(userId: UserId, displayname: string | null): Promise<void> {
    const user = this.usersByFullId.get(userId);
    if (!user) return;
    if (displayname === null) {
      delete user.displayname;
    } else {
      user.displayname = displayname;
    }
  }

  async setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void> {
    const user = this.usersByFullId.get(userId);
    if (!user) return;
    if (avatarUrl === null) {
      delete user.avatar_url;
    } else {
      user.avatar_url = avatarUrl;
    }
  }

  // Devices

  async getDevice(userId: UserId, deviceId: DeviceId): Promise<Device | undefined> {
    for (const session of this.sessions.values()) {
      if (session.user_id === userId && session.device_id === deviceId) {
        return {
          device_id: session.device_id,
          display_name: session.display_name,
          last_seen_ip: session.last_seen_ip,
          last_seen_ts: session.last_seen_ts,
        };
      }
    }
    return undefined;
  }

  async getAllDevices(userId: UserId): Promise<Device[]> {
    const result: Device[] = [];
    for (const session of this.sessions.values()) {
      if (session.user_id === userId) {
        result.push({
          device_id: session.device_id,
          display_name: session.display_name,
          last_seen_ip: session.last_seen_ip,
          last_seen_ts: session.last_seen_ts,
        });
      }
    }
    return result;
  }

  async updateDeviceDisplayName(userId: UserId, deviceId: DeviceId, displayName: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.user_id === userId && session.device_id === deviceId) {
        session.display_name = displayName;
        return;
      }
    }
  }

  async deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.user_id === userId && session.device_id === deviceId) {
        if (session.refresh_token) {
          this.refreshIndex.delete(session.refresh_token);
        }
        this.sessions.delete(token);
        return;
      }
    }
  }

  // Account

  async updatePassword(userId: UserId, newPasswordHash: string): Promise<void> {
    const user = this.usersByFullId.get(userId);
    if (user) {
      user.password_hash = newPasswordHash;
    }
  }

  async deactivateUser(userId: UserId): Promise<void> {
    const user = this.usersByFullId.get(userId);
    if (user) {
      user.is_deactivated = true;
    }
    await this.deleteAllSessions(userId);
  }

  // Aliases

  async createRoomAlias(roomAlias: RoomAlias, roomId: RoomId, servers: ServerName[], creator: UserId): Promise<void> {
    this.aliases.set(roomAlias, { room_id: roomId, servers, creator });
  }

  async deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean> {
    return this.aliases.delete(roomAlias);
  }

  async getRoomByAlias(roomAlias: RoomAlias): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined> {
    const entry = this.aliases.get(roomAlias);
    if (!entry) return undefined;
    return { room_id: entry.room_id, servers: entry.servers };
  }

  async getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]> {
    const result: RoomAlias[] = [];
    for (const [alias, entry] of this.aliases) {
      if (entry.room_id === roomId) result.push(alias);
    }
    return result;
  }

  async getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined> {
    return this.aliases.get(roomAlias)?.creator;
  }

  // Directory

  async setRoomVisibility(roomId: RoomId, visibility: "public" | "private"): Promise<void> {
    if (visibility === "public") {
      this.publicRooms.add(roomId);
    } else {
      this.publicRooms.delete(roomId);
    }
  }

  async getRoomVisibility(roomId: RoomId): Promise<"public" | "private"> {
    return this.publicRooms.has(roomId) ? "public" : "private";
  }

  async getPublicRoomIds(): Promise<RoomId[]> {
    return [...this.publicRooms];
  }
}
