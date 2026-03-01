import type { UserId, RoomId, RoomAlias, EventId, DeviceId, AccessToken, RefreshToken, Timestamp, ServerName } from "../types/index.ts";
import type { UserAccount, DeviceSession, RoomState } from "../types/index.ts";
import type { PDU, StrippedStateEvent } from "../types/events.ts";
import type { UserProfile, Device } from "../types/user.ts";
import type { JsonObject } from "../types/json.ts";

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

  // Rooms
  createRoom(state: RoomState): Promise<void>;
  getRoom(roomId: RoomId): Promise<RoomState | undefined>;
  getRoomsForUser(userId: UserId): Promise<RoomId[]>;

  // Events
  storeEvent(event: PDU, eventId: EventId): Promise<void>;
  getEvent(eventId: EventId): Promise<{ event: PDU; eventId: EventId } | undefined>;
  getEventsByRoom(roomId: RoomId, limit: number, from?: number, direction?: "b" | "f"): Promise<{ events: { event: PDU; eventId: EventId }[]; end?: number }>;
  getStreamPosition(): Promise<number>;

  // State
  getStateEvent(roomId: RoomId, eventType: string, stateKey: string): Promise<{ event: PDU; eventId: EventId } | undefined>;
  getAllState(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]>;
  setStateEvent(roomId: RoomId, event: PDU, eventId: EventId): Promise<void>;

  // Members
  getMemberEvents(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]>;

  // Transaction idempotency
  getTxnEventId(userId: UserId, deviceId: DeviceId, txnId: string): Promise<EventId | undefined>;
  setTxnEventId(userId: UserId, deviceId: DeviceId, txnId: string, eventId: EventId): Promise<void>;

  // Sync
  getRoomsForUserWithMembership(userId: UserId): Promise<{ roomId: RoomId; membership: string }[]>;
  getEventsByRoomSince(roomId: RoomId, since: number, limit: number): Promise<{ events: { event: PDU; eventId: EventId; streamPos: number }[]; limited: boolean }>;
  getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]>;
  waitForEvents(since: number, timeoutMs: number): Promise<void>;

  // Profile
  getProfile(userId: UserId): Promise<UserProfile | undefined>;
  setDisplayName(userId: UserId, displayname: string | null): Promise<void>;
  setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void>;

  // Devices
  getDevice(userId: UserId, deviceId: DeviceId): Promise<Device | undefined>;
  getAllDevices(userId: UserId): Promise<Device[]>;
  updateDeviceDisplayName(userId: UserId, deviceId: DeviceId, displayName: string): Promise<void>;
  deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void>;

  // Account
  updatePassword(userId: UserId, newPasswordHash: string): Promise<void>;
  deactivateUser(userId: UserId): Promise<void>;

  // Aliases
  createRoomAlias(roomAlias: RoomAlias, roomId: RoomId, servers: ServerName[], creator: UserId): Promise<void>;
  deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean>;
  getRoomByAlias(roomAlias: RoomAlias): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined>;
  getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]>;
  getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined>;

  // Directory
  setRoomVisibility(roomId: RoomId, visibility: "public" | "private"): Promise<void>;
  getRoomVisibility(roomId: RoomId): Promise<"public" | "private">;
  getPublicRoomIds(): Promise<RoomId[]>;

  // Account data
  getGlobalAccountData(userId: UserId, type: string): Promise<JsonObject | undefined>;
  setGlobalAccountData(userId: UserId, type: string, content: JsonObject): Promise<void>;
  getAllGlobalAccountData(userId: UserId): Promise<{ type: string; content: JsonObject }[]>;
  getRoomAccountData(userId: UserId, roomId: RoomId, type: string): Promise<JsonObject | undefined>;
  setRoomAccountData(userId: UserId, roomId: RoomId, type: string, content: JsonObject): Promise<void>;
  getAllRoomAccountData(userId: UserId, roomId: RoomId): Promise<{ type: string; content: JsonObject }[]>;
}
