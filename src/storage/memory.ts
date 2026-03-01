import type { UserId, RoomId, RoomAlias, EventId, DeviceId, AccessToken, RefreshToken, Timestamp, ServerName } from "../types/index.ts";
import type { UserAccount, RoomState, StoredMedia } from "../types/index.ts";
import type { PDU, StrippedStateEvent } from "../types/events.ts";
import type { UserProfile, Device } from "../types/user.ts";
import type { JsonObject } from "../types/json.ts";
import type { PresenceState } from "../types/ephemeral.ts";
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
  private globalAccountData = new Map<UserId, Map<string, JsonObject>>();
  private roomAccountDataMap = new Map<string, Map<string, JsonObject>>();
  private typingTimers = new Map<RoomId, Map<UserId, ReturnType<typeof setTimeout>>>();
  private receiptsMap = new Map<RoomId, Map<string, { eventId: EventId; ts: Timestamp }>>();
  private presenceMap = new Map<UserId, { presence: PresenceState; status_msg?: string; last_active_ts?: Timestamp }>();
  private mediaStore = new Map<string, { metadata: StoredMedia; data: Buffer }>();
  private filters = new Map<UserId, Map<string, JsonObject>>();
  private filterCounter = 0;

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

  // Account data

  async getGlobalAccountData(userId: UserId, type: string): Promise<JsonObject | undefined> {
    return this.globalAccountData.get(userId)?.get(type);
  }

  async setGlobalAccountData(userId: UserId, type: string, content: JsonObject): Promise<void> {
    let userMap = this.globalAccountData.get(userId);
    if (!userMap) {
      userMap = new Map();
      this.globalAccountData.set(userId, userMap);
    }
    userMap.set(type, content);
  }

  async getAllGlobalAccountData(userId: UserId): Promise<{ type: string; content: JsonObject }[]> {
    const userMap = this.globalAccountData.get(userId);
    if (!userMap) return [];
    const result: { type: string; content: JsonObject }[] = [];
    for (const [type, content] of userMap) {
      result.push({ type, content });
    }
    return result;
  }

  async getRoomAccountData(userId: UserId, roomId: RoomId, type: string): Promise<JsonObject | undefined> {
    const key = `${userId}\0${roomId}`;
    return this.roomAccountDataMap.get(key)?.get(type);
  }

  async setRoomAccountData(userId: UserId, roomId: RoomId, type: string, content: JsonObject): Promise<void> {
    const key = `${userId}\0${roomId}`;
    let dataMap = this.roomAccountDataMap.get(key);
    if (!dataMap) {
      dataMap = new Map();
      this.roomAccountDataMap.set(key, dataMap);
    }
    dataMap.set(type, content);
  }

  async getAllRoomAccountData(userId: UserId, roomId: RoomId): Promise<{ type: string; content: JsonObject }[]> {
    const key = `${userId}\0${roomId}`;
    const dataMap = this.roomAccountDataMap.get(key);
    if (!dataMap) return [];
    const result: { type: string; content: JsonObject }[] = [];
    for (const [type, content] of dataMap) {
      result.push({ type, content });
    }
    return result;
  }

  // Typing

  private wakeWaiters(): void {
    for (const waiter of this.eventWaiters) {
      waiter();
    }
  }

  async setTyping(roomId: RoomId, userId: UserId, typing: boolean, timeout?: number): Promise<void> {
    let roomTyping = this.typingTimers.get(roomId);
    if (!roomTyping) {
      roomTyping = new Map();
      this.typingTimers.set(roomId, roomTyping);
    }

    // Clear existing timer
    const existing = roomTyping.get(userId);
    if (existing) {
      clearTimeout(existing);
      roomTyping.delete(userId);
    }

    if (typing) {
      const ms = Math.min(timeout ?? 30000, 120000);
      const timer = setTimeout(() => {
        roomTyping!.delete(userId);
        this.wakeWaiters();
      }, ms);
      roomTyping.set(userId, timer);
    }

    this.wakeWaiters();
  }

  async getTypingUsers(roomId: RoomId): Promise<UserId[]> {
    const roomTyping = this.typingTimers.get(roomId);
    if (!roomTyping) return [];
    return [...roomTyping.keys()];
  }

  // Receipts

  async setReceipt(roomId: RoomId, userId: UserId, eventId: EventId, receiptType: string, ts: Timestamp): Promise<void> {
    let roomReceipts = this.receiptsMap.get(roomId);
    if (!roomReceipts) {
      roomReceipts = new Map();
      this.receiptsMap.set(roomId, roomReceipts);
    }
    const key = `${userId}\0${receiptType}`;
    roomReceipts.set(key, { eventId, ts });
    this.wakeWaiters();
  }

  async getReceipts(roomId: RoomId): Promise<{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]> {
    const roomReceipts = this.receiptsMap.get(roomId);
    if (!roomReceipts) return [];
    const result: { eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[] = [];
    for (const [key, value] of roomReceipts) {
      const [userId, receiptType] = key.split("\0") as [UserId, string];
      result.push({ eventId: value.eventId, receiptType, userId, ts: value.ts });
    }
    return result;
  }

  // Presence

  async setPresence(userId: UserId, presence: PresenceState, statusMsg?: string): Promise<void> {
    this.presenceMap.set(userId, {
      presence,
      status_msg: statusMsg,
      last_active_ts: Date.now(),
    });
    this.wakeWaiters();
  }

  async getPresence(userId: UserId): Promise<{ presence: PresenceState; status_msg?: string; last_active_ts?: Timestamp } | undefined> {
    return this.presenceMap.get(userId);
  }

  // Media

  async storeMedia(media: StoredMedia, data: Buffer): Promise<void> {
    const key = `${media.origin}/${media.media_id}`;
    this.mediaStore.set(key, { metadata: media, data });
  }

  async getMedia(serverName: ServerName, mediaId: string): Promise<{ metadata: StoredMedia; data: Buffer } | undefined> {
    return this.mediaStore.get(`${serverName}/${mediaId}`);
  }

  // Filters

  async createFilter(userId: UserId, filter: JsonObject): Promise<string> {
    let userFilters = this.filters.get(userId);
    if (!userFilters) {
      userFilters = new Map();
      this.filters.set(userId, userFilters);
    }
    const filterId = String(++this.filterCounter);
    userFilters.set(filterId, filter);
    return filterId;
  }

  async getFilter(userId: UserId, filterId: string): Promise<JsonObject | undefined> {
    return this.filters.get(userId)?.get(filterId);
  }
}
