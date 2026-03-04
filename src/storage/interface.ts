import type {
	UserId,
	RoomId,
	RoomAlias,
	EventId,
	DeviceId,
	AccessToken,
	RefreshToken,
	Timestamp,
	ServerName,
	KeyId,
} from "../types/index.ts";
import type {
	UserAccount,
	DeviceSession,
	RoomState,
	StoredMedia,
} from "../types/index.ts";
import type {
	PDU,
	StrippedStateEvent,
	ToDeviceEvent,
} from "../types/events.ts";
import type { UserProfile, Device } from "../types/user.ts";
import type { JsonObject } from "../types/json.ts";
import type { PresenceState } from "../types/ephemeral.ts";
import type { DeviceKeys, OneTimeKey } from "../types/e2ee.ts";
import type { Pusher } from "../types/push.ts";
import type { ServerKeys } from "../types/federation.ts";
import type { RoomVersion } from "../types/room-versions.ts";

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
	getSessionByAccessToken(
		token: AccessToken,
	): Promise<StoredSession | undefined>;
	getSessionByRefreshToken(
		token: RefreshToken,
	): Promise<StoredSession | undefined>;
	getSessionsByUser(userId: UserId): Promise<StoredSession[]>;
	deleteSession(token: AccessToken): Promise<void>;
	deleteAllSessions(userId: UserId): Promise<void>;
	rotateToken(
		oldAccessToken: AccessToken,
		newAccessToken: AccessToken,
		newRefreshToken?: RefreshToken,
		expiresAt?: Timestamp,
	): Promise<StoredSession | undefined>;
	touchSession(
		token: AccessToken,
		ip: string,
		userAgent: string,
	): Promise<void>;

	// UIAA Sessions
	createUIAASession(sessionId: string): Promise<void>;
	getUIAASession(
		sessionId: string,
	): Promise<{ completed: string[] } | undefined>;
	addUIAACompleted(sessionId: string, stageType: string): Promise<void>;
	deleteUIAASession(sessionId: string): Promise<void>;

	// Rooms
	createRoom(state: RoomState): Promise<void>;
	getRoom(roomId: RoomId): Promise<RoomState | undefined>;
	getRoomsForUser(userId: UserId): Promise<RoomId[]>;

	// Events
	storeEvent(event: PDU, eventId: EventId): Promise<void>;
	getEvent(
		eventId: EventId,
	): Promise<{ event: PDU; eventId: EventId } | undefined>;
	getEventsByRoom(
		roomId: RoomId,
		limit: number,
		from?: number,
		direction?: "b" | "f",
	): Promise<{ events: { event: PDU; eventId: EventId }[]; end?: number }>;
	getStreamPosition(): Promise<number>;

	// State
	getStateEvent(
		roomId: RoomId,
		eventType: string,
		stateKey: string,
	): Promise<{ event: PDU; eventId: EventId } | undefined>;
	getAllState(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]>;
	setStateEvent(roomId: RoomId, event: PDU, eventId: EventId): Promise<void>;

	// Members
	getMemberEvents(roomId: RoomId): Promise<{ event: PDU; eventId: EventId }[]>;

	// Transaction idempotency
	getTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
	): Promise<EventId | undefined>;
	setTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
		eventId: EventId,
	): Promise<void>;

	// Sync
	getRoomsForUserWithMembership(
		userId: UserId,
	): Promise<{ roomId: RoomId; membership: string }[]>;
	getEventsByRoomSince(
		roomId: RoomId,
		since: number,
		limit: number,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		limited: boolean;
	}>;
	getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]>;
	waitForEvents(since: number, timeoutMs: number): Promise<void>;

	// Profile
	getProfile(userId: UserId): Promise<UserProfile | undefined>;
	setDisplayName(userId: UserId, displayname: string | null): Promise<void>;
	setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void>;

	// Devices
	getDevice(userId: UserId, deviceId: DeviceId): Promise<Device | undefined>;
	getAllDevices(userId: UserId): Promise<Device[]>;
	updateDeviceDisplayName(
		userId: UserId,
		deviceId: DeviceId,
		displayName: string,
	): Promise<void>;
	deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void>;

	// Account
	updatePassword(userId: UserId, newPasswordHash: string): Promise<void>;
	deactivateUser(userId: UserId): Promise<void>;

	// Aliases
	createRoomAlias(
		roomAlias: RoomAlias,
		roomId: RoomId,
		servers: ServerName[],
		creator: UserId,
	): Promise<void>;
	deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean>;
	getRoomByAlias(
		roomAlias: RoomAlias,
	): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined>;
	getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]>;
	getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined>;

	// Directory
	setRoomVisibility(
		roomId: RoomId,
		visibility: "public" | "private",
	): Promise<void>;
	getRoomVisibility(roomId: RoomId): Promise<"public" | "private">;
	getPublicRoomIds(): Promise<RoomId[]>;

	// Account data
	getGlobalAccountData(
		userId: UserId,
		type: string,
	): Promise<JsonObject | undefined>;
	setGlobalAccountData(
		userId: UserId,
		type: string,
		content: JsonObject,
	): Promise<void>;
	getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]>;
	getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined>;
	setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void>;
	getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]>;

	// Typing
	setTyping(
		roomId: RoomId,
		userId: UserId,
		typing: boolean,
		timeout?: number,
	): Promise<void>;
	getTypingUsers(roomId: RoomId): Promise<UserId[]>;

	// Receipts
	setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
	): Promise<void>;
	getReceipts(
		roomId: RoomId,
	): Promise<
		{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]
	>;

	// Presence
	setPresence(
		userId: UserId,
		presence: PresenceState,
		statusMsg?: string,
	): Promise<void>;
	getPresence(
		userId: UserId,
	): Promise<
		| {
				presence: PresenceState;
				status_msg?: string;
				last_active_ts?: Timestamp;
		  }
		| undefined
	>;

	// Media
	storeMedia(media: StoredMedia, data: Buffer): Promise<void>;
	getMedia(
		serverName: ServerName,
		mediaId: string,
	): Promise<{ metadata: StoredMedia; data: Buffer } | undefined>;

	// Filters
	createFilter(userId: UserId, filter: JsonObject): Promise<string>;
	getFilter(userId: UserId, filterId: string): Promise<JsonObject | undefined>;

	// E2EE - Device keys
	setDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: DeviceKeys,
	): Promise<void>;
	getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined>;
	getAllDeviceKeys(userId: UserId): Promise<Record<DeviceId, DeviceKeys>>;

	// E2EE - One-time keys
	addOneTimeKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void>;
	claimOneTimeKey(
		userId: UserId,
		deviceId: DeviceId,
		algorithm: string,
	): Promise<{ keyId: KeyId; key: string | OneTimeKey } | undefined>;
	getOneTimeKeyCounts(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Record<string, number>>;

	// E2EE - Fallback keys
	setFallbackKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void>;
	getFallbackKeyTypes(userId: UserId, deviceId: DeviceId): Promise<string[]>;

	// To-device messages
	sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void>;
	getToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<ToDeviceEvent[]>;
	clearToDeviceMessages(userId: UserId, deviceId: DeviceId): Promise<void>;

	// Pushers
	getPushers(userId: UserId): Promise<Pusher[]>;
	setPusher(userId: UserId, pusher: Pusher): Promise<void>;
	deletePusher(userId: UserId, appId: string, pushkey: string): Promise<void>;
	deletePusherByKey(appId: string, pushkey: string): Promise<void>;

	// Relations
	storeRelation(
		eventId: EventId,
		roomId: RoomId,
		relType: string,
		targetEventId: EventId,
		key?: string,
	): Promise<void>;
	getRelatedEvents(
		roomId: RoomId,
		eventId: EventId,
		relType?: string,
		eventType?: string,
		limit?: number,
		from?: string,
		direction?: "b" | "f",
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		nextBatch?: string;
	}>;
	getAnnotationCounts(
		eventId: EventId,
	): Promise<{ type: string; key: string; count: number }[]>;
	getLatestEdit(
		eventId: EventId,
		sender: UserId,
	): Promise<{ event: PDU; eventId: EventId } | undefined>;
	getThreadSummary(
		eventId: EventId,
		userId: UserId,
	): Promise<
		| {
				latestEvent: { event: PDU; eventId: EventId };
				count: number;
				currentUserParticipated: boolean;
		  }
		| undefined
	>;

	// Reports
	storeReport(
		userId: UserId,
		roomId: RoomId,
		eventId: EventId,
		score?: number,
		reason?: string,
	): Promise<void>;

	// OpenID
	storeOpenIdToken(
		token: string,
		userId: UserId,
		expiresAt: Timestamp,
	): Promise<void>;
	getOpenIdToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: Timestamp } | undefined>;

	// 3PIDs
	getThreePids(
		userId: UserId,
	): Promise<{ medium: string; address: string; added_at: Timestamp }[]>;
	addThreePid(userId: UserId, medium: string, address: string): Promise<void>;
	deleteThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void>;

	// User directory
	searchUserDirectory(
		searchTerm: string,
		limit: number,
	): Promise<{ user_id: UserId; display_name?: string; avatar_url?: string }[]>;

	// Thread roots
	getThreadRoots(
		roomId: RoomId,
		userId: UserId,
		include: "all" | "participated",
		limit: number,
		from?: string,
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		nextBatch?: string;
	}>;

	// Search
	searchRoomEvents(
		roomIds: RoomId[],
		searchTerm: string,
		keys: string[],
		limit: number,
		from?: string,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		nextBatch?: string;
	}>;

	// Federation - Remote server key cache
	storeServerKeys(serverName: ServerName, keys: ServerKeys): Promise<void>;
	getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined>;

	// Federation - Auth chain & state queries
	getAuthChain(eventIds: EventId[]): Promise<PDU[]>;
	getServersInRoom(roomId: RoomId): Promise<ServerName[]>;
	getStateAtEvent(
		roomId: RoomId,
		eventId: EventId,
	): Promise<Map<string, PDU> | undefined>;

	// Federation - Transaction dedup
	getFederationTxn(origin: ServerName, txnId: string): Promise<boolean>;
	setFederationTxn(origin: ServerName, txnId: string): Promise<void>;

	// Federation - Room import
	importRoomState(
		roomId: RoomId,
		roomVersion: RoomVersion,
		stateEvents: PDU[],
		authChain: PDU[],
	): Promise<void>;
}
