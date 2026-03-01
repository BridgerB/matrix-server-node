import type { UserId, RoomId, EventId, DeviceId, AccessToken, RefreshToken, Timestamp } from "../types/index.ts";
import type { UserAccount, DeviceSession, RoomState } from "../types/index.ts";
import type { PDU } from "../types/events.ts";

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
}
