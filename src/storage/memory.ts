import { createHash } from "node:crypto";
import { computeEventId } from "../events.ts";
import {
	eventMatchesSearchTerm,
	paginateSearchMatches,
} from "../search-match.ts";
import type {
	CrossSigningKey,
	DeviceKeys,
	KeyBackupData,
	OneTimeKey,
} from "../types/e2ee.ts";
import type {
	EDU,
	PDU,
	StrippedStateEvent,
	ToDeviceEvent,
} from "../types/events.ts";
import type { ServerKeys } from "../types/federation.ts";
import type {
	AccessToken,
	DeviceId,
	EventId,
	KeyId,
	RefreshToken,
	RoomAlias,
	RoomId,
	RoomState,
	ServerName,
	StoredMedia,
	Timestamp,
	UserAccount,
	UserId,
} from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";
import type { Pusher } from "../types/push.ts";
import type { RoomVersion } from "../types/room-versions.ts";
import type { Device, UserProfile } from "../types/user.ts";
import {
	EphemeralMixin,
	eventToStrippedState,
	INVITE_STATE_TYPES,
} from "./ephemeral.ts";
import {
	collapseReceiptsMsc4102,
	PENDING_FEDERATION_EDU_CAP,
} from "./interface.ts";
import type { Storage, StoredSession } from "./interface.ts";

/** True for an empty JSON object `{}` (MSC3391 account-data tombstone). */
function isEmptyJsonObject(content: JsonObject): boolean {
	return Object.keys(content).length === 0;
}

export class MemoryStorage extends EphemeralMixin implements Storage {
	private users = new Map<string, UserAccount>();
	private usersByFullId = new Map<UserId, UserAccount>();
	private sessions = new Map<AccessToken, StoredSession>();
	private refreshIndex = new Map<RefreshToken, AccessToken>();
	private uiaaSessions = new Map<string, { completed: string[] }>();
	private rooms = new Map<RoomId, RoomState>();
	private events = new Map<EventId, PDU>();
	private roomTimeline = new Map<
		RoomId,
		{ eventId: EventId; streamPos: number }[]
	>();
	private txnMap = new Map<string, EventId>();
	private aliases = new Map<
		RoomAlias,
		{ room_id: RoomId; servers: ServerName[]; creator: UserId }
	>();
	private publicRooms = new Set<RoomId>();
	private globalAccountData = new Map<
		UserId,
		Map<string, { content: JsonObject; streamPos: number }>
	>();
	private roomAccountDataMap = new Map<
		string,
		Map<string, { content: JsonObject; streamPos: number }>
	>();
	private receiptsMap = new Map<
		RoomId,
		Map<string, { eventId: EventId; ts: Timestamp; threadId?: string }>
	>();
	private mediaStore = new Map<
		string,
		{ metadata: StoredMedia; data: Buffer }
	>();
	private filters = new Map<UserId, Map<string, JsonObject>>();
	private deviceKeysMap = new Map<string, DeviceKeys>();
	private deviceListStream: { userId: UserId; streamPos: number }[] = [];
	private oneTimeKeysMap = new Map<string, Map<KeyId, string | OneTimeKey>>();
	private fallbackKeysMap = new Map<string, Map<KeyId, string | OneTimeKey>>();
	private crossSigningKeysMap = new Map<
		UserId,
		{
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
		}
	>();
	private keyBackupVersions = new Map<
		UserId,
		{
			version: string;
			algorithm: string;
			auth_data: JsonObject;
		}[]
	>();
	private keyBackupData = new Map<
		string,
		Map<RoomId, Map<string, KeyBackupData>>
	>();
	private keyBackupCounter = 0;
	private toDeviceInbox = new Map<string, ToDeviceEvent[]>();
	private pushersMap = new Map<UserId, Pusher[]>();
	private relationsMap = new Map<
		EventId,
		{
			eventId: EventId;
			relType: string;
			key?: string;
			sender: UserId;
			eventType: string;
			streamPos: number;
		}[]
	>();
	private reports: {
		userId: UserId;
		roomId: RoomId;
		eventId: EventId;
		score?: number;
		reason?: string;
		ts: number;
	}[] = [];
	private openIdTokens = new Map<
		string,
		{ userId: UserId; expiresAt: number }
	>();
	private threePidsMap = new Map<
		UserId,
		{ medium: string; address: string; added_at: number }[]
	>();
	private serverKeysCache = new Map<
		string,
		{ key: string; validUntil: number }
	>();
	private federationTxns = new Set<string>();
	// Durable outbound EDU retry queue: destination -> ordered pending entries.
	private pendingFederationEdus = new Map<
		ServerName,
		{ id: number; edu: EDU }[]
	>();
	private pendingFederationEduCounter = 0;
	private verificationSessions = new Map<
		string,
		{
			medium: string;
			address: string;
			clientSecret: string;
			sendAttempt: number;
			token: string;
			validated: boolean;
			userId?: string;
		}
	>();
	private loginTokens = new Map<
		string,
		{ userId: UserId; expiresAt: number }
	>();

	async createUser(account: UserAccount): Promise<void> {
		this.users.set(account.localpart, account);
		this.usersByFullId.set(account.user_id, account);
	}

	async getUserByLocalpart(
		localpart: string,
	): Promise<UserAccount | undefined> {
		return this.users.get(localpart);
	}

	async getUserById(userId: UserId): Promise<UserAccount | undefined> {
		return this.usersByFullId.get(userId);
	}

	async createSession(session: StoredSession): Promise<void> {
		this.sessions.set(session.access_token, session);
		if (session.refresh_token) {
			this.refreshIndex.set(session.refresh_token, session.access_token);
		}
		// A new device/session was added: notify device-list subscribers.
		await this.recordDeviceKeyChange(session.user_id);
	}

	async getSessionByAccessToken(
		token: AccessToken,
	): Promise<StoredSession | undefined> {
		return this.sessions.get(token);
	}

	async getSessionByRefreshToken(
		token: RefreshToken,
	): Promise<StoredSession | undefined> {
		const accessToken = this.refreshIndex.get(token);
		if (!accessToken) return undefined;
		return this.sessions.get(accessToken);
	}

	async getSessionsByUser(userId: UserId): Promise<StoredSession[]> {
		return [...this.sessions.values()].filter((s) => s.user_id === userId);
	}

	async deleteSession(token: AccessToken): Promise<void> {
		const session = this.sessions.get(token);
		if (session?.refresh_token) {
			this.refreshIndex.delete(session.refresh_token);
		}
		this.sessions.delete(token);
		// A device/session was removed: notify device-list subscribers.
		if (session) {
			await this.recordDeviceKeyChange(session.user_id);
		}
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
		// Devices were removed: notify device-list subscribers.
		await this.recordDeviceKeyChange(userId);
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

	async touchSession(
		token: AccessToken,
		ip: string,
		userAgent: string,
	): Promise<void> {
		const session = this.sessions.get(token);
		if (session) {
			session.last_seen_ip = ip;
			session.last_seen_ts = Date.now();
			session.user_agent = userAgent;
		}
	}

	async createUIAASession(sessionId: string): Promise<void> {
		this.uiaaSessions.set(sessionId, { completed: [] });
	}

	async getUIAASession(
		sessionId: string,
	): Promise<{ completed: string[] } | undefined> {
		return this.uiaaSessions.get(sessionId);
	}

	async addUIAACompleted(sessionId: string, stageType: string): Promise<void> {
		this.uiaaSessions.get(sessionId)?.completed.push(stageType);
	}

	async deleteUIAASession(sessionId: string): Promise<void> {
		this.uiaaSessions.delete(sessionId);
	}

	async createRoom(state: RoomState): Promise<void> {
		this.rooms.set(state.room_id, state);
		this.roomTimeline.set(state.room_id, []);
	}

	async getRoom(roomId: RoomId): Promise<RoomState | undefined> {
		return this.rooms.get(roomId);
	}

	async getRoomsForUser(userId: UserId): Promise<RoomId[]> {
		return [...this.rooms.values()]
			.filter((room) => {
				const memberEvent = room.state_events.get(`m.room.member\x1f${userId}`);
				return (
					(memberEvent?.content as Record<string, unknown>)?.membership ===
					"join"
				);
			})
			.map((room) => room.room_id);
	}

	async storeEvent(event: PDU, eventId: EventId): Promise<void> {
		this.events.set(eventId, event);
		const timeline = this.roomTimeline.get(event.room_id);
		if (timeline) {
			this.streamCounter++;
			timeline.push({ eventId, streamPos: this.streamCounter });
		}
		this.wakeWaiters();
	}

	async updateEvent(eventId: EventId, event: PDU): Promise<void> {
		this.events.set(eventId, event);
	}

	async getEvent(
		eventId: EventId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
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

		const filtered =
			direction === "f"
				? timeline.filter((e) => e.streamPos > fromPos)
				: timeline.filter((e) => e.streamPos < fromPos).reverse();

		const sliced = filtered.slice(0, limit);
		const events = sliced.map((e) => ({
			event: this.events.get(e.eventId) as PDU,
			eventId: e.eventId,
		}));

		return { events, end: sliced[sliced.length - 1]?.streamPos };
	}

	async getStreamPosition(): Promise<number> {
		return this.streamCounter;
	}

	async getStateEvent(
		roomId: RoomId,
		eventType: string,
		stateKey: string,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const room = this.rooms.get(roomId);
		const event = room?.state_events.get(`${eventType}\x1f${stateKey}`);
		if (!event) return undefined;
		return { event, eventId: computeEventId(event, room?.room_version) };
	}

	async getAllState(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];
		return [...room.state_events.values()].map((event) => ({
			event,
			eventId: computeEventId(event, room.room_version),
		}));
	}

	async setStateEvent(
		roomId: RoomId,
		event: PDU,
		eventId: EventId,
	): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room) return;
		const key = `${event.type}\x1f${event.state_key ?? ""}`;
		// When this state event replaces a previous one of the same
		// (type, state_key), stamp the new event's unsigned with the prior
		// state per the spec: prev_content / prev_sender / replaces_state.
		// `unsigned` is excluded from content-hash / event-ID / signature
		// computation, so mutating it here is safe and does not alter eventId.
		const previous = room.state_events.get(key);
		if (previous) {
			const previousId = computeEventId(previous, room.room_version);
			if (previousId !== eventId) {
				event.unsigned = {
					...(event.unsigned ?? {}),
					prev_content: previous.content,
					prev_sender: previous.sender,
					replaces_state: previousId,
				};
			}
		}
		room.state_events.set(key, event);
		await this.storeEvent(event, eventId);
	}

	async getMemberEvents(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];
		return [...room.state_events.entries()]
			.filter(([key]) => key.startsWith("m.room.member\x1f"))
			.map(([, event]) => ({
				event,
				eventId: computeEventId(event, room.room_version),
			}));
	}

	async getTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
	): Promise<EventId | undefined> {
		return this.txnMap.get(`${userId}|${deviceId}|${txnId}`);
	}

	async setTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
		eventId: EventId,
	): Promise<void> {
		this.txnMap.set(`${userId}|${deviceId}|${txnId}`, eventId);
	}

	async getRoomsForUserWithMembership(
		userId: UserId,
	): Promise<{ roomId: RoomId; membership: string }[]> {
		return [...this.rooms.values()]
			.map((room) => {
				const memberEvent = room.state_events.get(`m.room.member\x1f${userId}`);
				const membership = (memberEvent?.content as Record<string, unknown>)
					?.membership as string | undefined;
				return membership ? { roomId: room.room_id, membership } : undefined;
			})
			.filter(
				(entry): entry is { roomId: RoomId; membership: string } =>
					entry !== undefined,
			);
	}

	async getEventsByRoomSince(
		roomId: RoomId,
		since: number,
		limit: number,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		limited: boolean;
	}> {
		const timeline = this.roomTimeline.get(roomId) ?? [];
		const filtered = timeline.filter((e) => e.streamPos > since);
		const limited = filtered.length > limit;
		const sliced = limited ? filtered.slice(filtered.length - limit) : filtered;
		const events = sliced.map((e) => ({
			event: this.events.get(e.eventId) as PDU,
			eventId: e.eventId,
			streamPos: e.streamPos,
		}));
		return { events, limited };
	}

	async getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];
		return [...room.state_events.entries()]
			.filter(([key]) =>
				INVITE_STATE_TYPES.includes(
					key.split("\x1f")[0] as (typeof INVITE_STATE_TYPES)[number],
				),
			)
			.map(([, event]) => eventToStrippedState(event));
	}

	async getProfile(userId: UserId): Promise<UserProfile | undefined> {
		const user = this.usersByFullId.get(userId);
		if (!user) return undefined;
		const profile: UserProfile = {};
		if (user.displayname) profile.displayname = user.displayname;
		if (user.avatar_url) profile.avatar_url = user.avatar_url;
		return profile;
	}

	async setDisplayName(
		userId: UserId,
		displayname: string | null,
	): Promise<void> {
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

	async getDevice(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Device | undefined> {
		const session = [...this.sessions.values()].find(
			(s) => s.user_id === userId && s.device_id === deviceId,
		);
		if (!session) return undefined;
		return {
			device_id: session.device_id,
			display_name: session.display_name,
			last_seen_ip: session.last_seen_ip,
			last_seen_ts: session.last_seen_ts,
		};
	}

	async getAllDevices(userId: UserId): Promise<Device[]> {
		return [...this.sessions.values()]
			.filter((s) => s.user_id === userId)
			.map((s) => ({
				device_id: s.device_id,
				display_name: s.display_name,
				last_seen_ip: s.last_seen_ip,
				last_seen_ts: s.last_seen_ts,
			}));
	}

	async updateDeviceDisplayName(
		userId: UserId,
		deviceId: DeviceId,
		displayName: string,
	): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.user_id === userId && session.device_id === deviceId) {
				session.display_name = displayName;
				// A device's display name changed: notify device-list
				// subscribers. Mirrors Synapse's DeviceHandler, where
				// update_device (display-name change) calls notify_device_update
				// so local /sync device_lists.changed and /keys/changes, plus
				// federated m.device_list_update, pick up the change.
				await this.recordDeviceKeyChange(userId);
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
				break;
			}
		}
		// A device was removed: notify device-list subscribers.
		await this.recordDeviceKeyChange(userId);
	}

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

	async createRoomAlias(
		roomAlias: RoomAlias,
		roomId: RoomId,
		servers: ServerName[],
		creator: UserId,
	): Promise<void> {
		this.aliases.set(roomAlias, { room_id: roomId, servers, creator });
	}

	async deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean> {
		return this.aliases.delete(roomAlias);
	}

	async getRoomByAlias(
		roomAlias: RoomAlias,
	): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined> {
		const entry = this.aliases.get(roomAlias);
		if (!entry) return undefined;
		return { room_id: entry.room_id, servers: entry.servers };
	}

	async getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]> {
		return [...this.aliases.entries()]
			.filter(([, entry]) => entry.room_id === roomId)
			.map(([alias]) => alias);
	}

	async getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined> {
		return this.aliases.get(roomAlias)?.creator;
	}

	async setRoomVisibility(
		roomId: RoomId,
		visibility: "public" | "private",
	): Promise<void> {
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

	async getGlobalAccountData(
		userId: UserId,
		type: string,
	): Promise<JsonObject | undefined> {
		return this.globalAccountData.get(userId)?.get(type)?.content;
	}

	async setGlobalAccountData(
		userId: UserId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		let userMap = this.globalAccountData.get(userId);
		if (!userMap) {
			userMap = new Map();
			this.globalAccountData.set(userId, userMap);
		}
		userMap.set(type, { content, streamPos: ++this.streamCounter });
		this.wakeWaiters();
	}

	async getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const userMap = this.globalAccountData.get(userId);
		if (!userMap) return [];
		// Exclude MSC3391 deletion tombstones (empty content) from initial sync.
		return [...userMap.entries()]
			.filter(([, v]) => !isEmptyJsonObject(v.content))
			.map(([type, v]) => ({ type, content: v.content }));
	}

	async getGlobalAccountDataSince(
		userId: UserId,
		since: number,
	): Promise<{ type: string; content: JsonObject }[]> {
		const userMap = this.globalAccountData.get(userId);
		if (!userMap) return [];
		// Include tombstones so incremental sync surfaces deletions.
		return [...userMap.entries()]
			.filter(([, v]) => v.streamPos > since)
			.map(([type, v]) => ({ type, content: v.content }));
	}

	async getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined> {
		return this.roomAccountDataMap.get(`${userId}\x1f${roomId}`)?.get(type)
			?.content;
	}

	async setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		const key = `${userId}\x1f${roomId}`;
		let dataMap = this.roomAccountDataMap.get(key);
		if (!dataMap) {
			dataMap = new Map();
			this.roomAccountDataMap.set(key, dataMap);
		}
		dataMap.set(type, { content, streamPos: ++this.streamCounter });
		this.wakeWaiters();
	}
	async deleteGlobalAccountData(userId: UserId, type: string): Promise<void> {
		// MSC3391: leave a tombstone (empty content) with a fresh stream position
		// rather than removing the entry, so incremental sync can surface it.
		let userMap = this.globalAccountData.get(userId);
		if (!userMap) {
			userMap = new Map();
			this.globalAccountData.set(userId, userMap);
		}
		userMap.set(type, { content: {}, streamPos: ++this.streamCounter });
		this.wakeWaiters();
	}
	async deleteRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<void> {
		const key = `${userId}\x1f${roomId}`;
		let dataMap = this.roomAccountDataMap.get(key);
		if (!dataMap) {
			dataMap = new Map();
			this.roomAccountDataMap.set(key, dataMap);
		}
		dataMap.set(type, { content: {}, streamPos: ++this.streamCounter });
		this.wakeWaiters();
	}

	async getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const dataMap = this.roomAccountDataMap.get(`${userId}\x1f${roomId}`);
		if (!dataMap) return [];
		// Exclude MSC3391 deletion tombstones from initial sync.
		return [...dataMap.entries()]
			.filter(([, v]) => !isEmptyJsonObject(v.content))
			.map(([type, v]) => ({ type, content: v.content }));
	}

	async getRoomAccountDataSince(
		userId: UserId,
		since: number,
	): Promise<{ roomId: RoomId; type: string; content: JsonObject }[]> {
		const prefix = `${userId}\x1f`;
		const out: { roomId: RoomId; type: string; content: JsonObject }[] = [];
		for (const [key, dataMap] of this.roomAccountDataMap.entries()) {
			if (!key.startsWith(prefix)) continue;
			const roomId = key.slice(prefix.length) as RoomId;
			for (const [type, v] of dataMap.entries()) {
				if (v.streamPos > since) out.push({ roomId, type, content: v.content });
			}
		}
		return out;
	}

	async setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
		threadId?: string,
	): Promise<void> {
		let roomReceipts = this.receiptsMap.get(roomId);
		if (!roomReceipts) {
			roomReceipts = new Map();
			this.receiptsMap.set(roomId, roomReceipts);
		}
		// Key by (userId, receiptType, threadId) so an unthreaded receipt and
		// receipts in distinct threads coexist as separate entries. Empty string
		// is the sentinel for "no thread".
		roomReceipts.set(`${userId}\x1f${receiptType}\x1f${threadId ?? ""}`, {
			eventId,
			ts,
			threadId,
		});
		this.wakeWaiters();
	}

	async getReceipts(roomId: RoomId): Promise<
		{
			eventId: EventId;
			receiptType: string;
			userId: UserId;
			ts: Timestamp;
			threadId?: string;
		}[]
	> {
		const roomReceipts = this.receiptsMap.get(roomId);
		if (!roomReceipts) return [];
		const rows = [...roomReceipts.entries()].map(([key, value]) => {
			const [userId, receiptType] = key.split("\x1f") as [UserId, string];
			return {
				eventId: value.eventId,
				receiptType,
				userId,
				ts: value.ts,
				threadId: value.threadId,
			};
		});
		return collapseReceiptsMsc4102(rows);
	}

	async storeMedia(media: StoredMedia, data: Buffer): Promise<void> {
		this.mediaStore.set(`${media.origin}/${media.media_id}`, {
			metadata: media,
			data,
		});
	}

	async getMedia(
		serverName: ServerName,
		mediaId: string,
	): Promise<{ metadata: StoredMedia; data: Buffer } | undefined> {
		return this.mediaStore.get(`${serverName}/${mediaId}`);
	}

	async reserveMedia(media: StoredMedia): Promise<void> {
		this.mediaStore.set(`${media.origin}/${media.media_id}`, {
			metadata: media,
			data: Buffer.alloc(0),
		});
	}

	async updateMediaContent(
		serverName: ServerName,
		mediaId: string,
		contentType: string,
		fileName: string | undefined,
		data: Buffer,
	): Promise<boolean> {
		const key = `${serverName}/${mediaId}`;
		const existing = this.mediaStore.get(key);
		if (!existing) return false;
		const hash = createHash("sha256").update(data).digest("base64");
		existing.metadata.content_type = contentType;
		existing.metadata.upload_name = fileName;
		existing.metadata.file_size = data.length;
		existing.metadata.content_hash = hash;
		existing.data = data;
		return true;
	}

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

	async getFilter(
		userId: UserId,
		filterId: string,
	): Promise<JsonObject | undefined> {
		return this.filters.get(userId)?.get(filterId);
	}

	async setDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: DeviceKeys,
	): Promise<void> {
		this.deviceKeysMap.set(`${userId}\x1f${deviceId}`, keys);
		await this.recordDeviceKeyChange(userId);
	}

	async recordDeviceKeyChange(userId: UserId): Promise<void> {
		this.deviceListStream.push({ userId, streamPos: ++this.streamCounter });
		this.wakeWaiters();
	}

	async getChangedDeviceUsers(since: number, until: number): Promise<UserId[]> {
		const seen = new Set<UserId>();
		for (const entry of this.deviceListStream) {
			if (entry.streamPos > since && entry.streamPos <= until) {
				seen.add(entry.userId);
			}
		}
		return [...seen];
	}

	async getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined> {
		return this.deviceKeysMap.get(`${userId}\x1f${deviceId}`);
	}

	async getAllDeviceKeys(
		userId: UserId,
	): Promise<Record<DeviceId, DeviceKeys>> {
		const result: Record<DeviceId, DeviceKeys> = {};
		const prefix = `${userId}\x1f`;
		for (const [key, value] of this.deviceKeysMap) {
			if (key.startsWith(prefix)) {
				result[key.slice(prefix.length) as DeviceId] = value;
			}
		}
		return result;
	}

	async addOneTimeKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const mapKey = `${userId}\x1f${deviceId}`;
		let otks = this.oneTimeKeysMap.get(mapKey);
		if (!otks) {
			otks = new Map();
			this.oneTimeKeysMap.set(mapKey, otks);
		}
		for (const [keyId, key] of Object.entries(keys)) {
			otks.set(keyId as KeyId, key);
		}
	}

	async claimOneTimeKey(
		userId: UserId,
		deviceId: DeviceId,
		algorithm: string,
	): Promise<{ keyId: KeyId; key: string | OneTimeKey } | undefined> {
		const mapKey = `${userId}\x1f${deviceId}`;
		const otks = this.oneTimeKeysMap.get(mapKey);
		if (otks) {
			for (const [keyId, key] of otks) {
				if (keyId.startsWith(`${algorithm}:`)) {
					otks.delete(keyId);
					return { keyId, key };
				}
			}
		}
		const fallbacks = this.fallbackKeysMap.get(mapKey);
		if (fallbacks) {
			for (const [keyId, key] of fallbacks) {
				if (keyId.startsWith(`${algorithm}:`)) {
					return { keyId, key };
				}
			}
		}
		return undefined;
	}

	async getOneTimeKeyCounts(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Record<string, number>> {
		const otks = this.oneTimeKeysMap.get(`${userId}\x1f${deviceId}`);
		if (!otks) return {};
		const counts: Record<string, number> = {};
		for (const keyId of otks.keys()) {
			const algorithm = keyId.split(":")[0] as string;
			counts[algorithm] = (counts[algorithm] ?? 0) + 1;
		}
		return counts;
	}

	async setFallbackKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const fallbacks = new Map<KeyId, string | OneTimeKey>();
		for (const [keyId, key] of Object.entries(keys)) {
			fallbacks.set(keyId as KeyId, key);
		}
		this.fallbackKeysMap.set(`${userId}\x1f${deviceId}`, fallbacks);
	}

	async getFallbackKeyTypes(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<string[]> {
		const fallbacks = this.fallbackKeysMap.get(`${userId}\x1f${deviceId}`);
		if (!fallbacks) return [];
		return [
			...new Set(
				[...fallbacks.keys()].map((keyId) => keyId.split(":")[0] as string),
			),
		];
	}

	// Cross-signing keys
	async setCrossSigningKeys(
		userId: UserId,
		keys: {
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
		},
	): Promise<void> {
		const existing = this.crossSigningKeysMap.get(userId) ?? {};
		if (keys.master_key) existing.master_key = keys.master_key;
		if (keys.self_signing_key)
			existing.self_signing_key = keys.self_signing_key;
		if (keys.user_signing_key)
			existing.user_signing_key = keys.user_signing_key;
		this.crossSigningKeysMap.set(userId, existing);
	}

	async getCrossSigningKeys(userId: UserId): Promise<{
		master_key?: CrossSigningKey;
		self_signing_key?: CrossSigningKey;
		user_signing_key?: CrossSigningKey;
	}> {
		return this.crossSigningKeysMap.get(userId) ?? {};
	}

	async storeCrossSigningSignatures(
		userId: UserId,
		signatures: Record<string, Record<string, JsonObject>>,
	): Promise<
		Record<string, Record<string, { errcode: string; error: string }>>
	> {
		// Store signatures onto device keys or cross-signing keys
		const failures: Record<
			string,
			Record<string, { errcode: string; error: string }>
		> = {};
		for (const [targetUserId, keyMap] of Object.entries(signatures)) {
			for (const [keyId, signedObject] of Object.entries(keyMap)) {
				const signedSigs = (signedObject as Record<string, unknown>)
					.signatures as Record<string, Record<string, string>> | undefined;
				if (!signedSigs) {
					failures[targetUserId] ??= {};
					(
						failures[targetUserId] as Record<
							string,
							{ errcode: string; error: string }
						>
					)[keyId] = {
						errcode: "M_INVALID_SIGNATURE",
						error: "Missing signatures field",
					};
					continue;
				}

				// Authorization: can only sign own devices or other users' master keys
				if (targetUserId !== userId) {
					const targetCrossKeys = this.crossSigningKeysMap.get(
						targetUserId as UserId,
					);
					const isMasterKey =
						targetCrossKeys?.master_key &&
						Object.keys(targetCrossKeys.master_key.keys).some(
							(k) => k === keyId || k.endsWith(`:${keyId}`),
						);
					if (!isMasterKey) {
						failures[targetUserId] ??= {};
						(
							failures[targetUserId] as Record<
								string,
								{ errcode: string; error: string }
							>
						)[keyId] = {
							errcode: "M_FORBIDDEN",
							error: "Can only sign own devices or other users' master keys",
						};
						continue;
					}
				}

				// Try updating device keys
				const deviceKeys = await this.getDeviceKeys(
					targetUserId as UserId,
					keyId as DeviceId,
				);
				if (deviceKeys) {
					if (!deviceKeys.signatures) deviceKeys.signatures = {};
					for (const [signer, sigs] of Object.entries(signedSigs)) {
						deviceKeys.signatures[signer] ??= {};
						Object.assign(
							deviceKeys.signatures[signer] as Record<string, string>,
							sigs,
						);
					}
					continue;
				}

				// Try updating cross-signing keys
				const crossKeys = this.crossSigningKeysMap.get(targetUserId as UserId);
				if (crossKeys) {
					let matched = false;
					for (const key of [
						crossKeys.master_key,
						crossKeys.self_signing_key,
						crossKeys.user_signing_key,
					]) {
						if (!key) continue;
						if (
							Object.keys(key.keys).some(
								(k) => k === keyId || k.endsWith(`:${keyId}`),
							)
						) {
							if (!key.signatures) key.signatures = {};
							for (const [signer, sigs] of Object.entries(signedSigs)) {
								key.signatures[signer] ??= {};
								Object.assign(
									key.signatures[signer] as Record<string, string>,
									sigs,
								);
							}
							matched = true;
							break;
						}
					}
					if (matched) continue;
				}

				failures[targetUserId] ??= {};
				(
					failures[targetUserId] as Record<
						string,
						{ errcode: string; error: string }
					>
				)[keyId] = {
					errcode: "M_NOT_FOUND",
					error: "Key not found",
				};
			}
		}
		return failures;
	}

	// Key backup
	async createKeyBackupVersion(
		userId: UserId,
		algorithm: string,
		authData: JsonObject,
	): Promise<string> {
		let versions = this.keyBackupVersions.get(userId);
		if (!versions) {
			versions = [];
			this.keyBackupVersions.set(userId, versions);
		}
		this.keyBackupCounter++;
		const version = String(this.keyBackupCounter);
		versions.push({ version, algorithm, auth_data: authData });
		return version;
	}

	async getKeyBackupVersion(
		userId: UserId,
		version?: string,
	): Promise<
		| {
				version: string;
				algorithm: string;
				auth_data: JsonObject;
				count: number;
				etag: string;
		  }
		| undefined
	> {
		const versions = this.keyBackupVersions.get(userId);
		if (!versions || versions.length === 0) return undefined;

		const v = version
			? versions.find((b) => b.version === version)
			: versions[versions.length - 1];
		if (!v) return undefined;

		const backupKey = `${userId}\x1f${v.version}`;
		const rooms = this.keyBackupData.get(backupKey);
		let count = 0;
		if (rooms) {
			for (const sessions of rooms.values()) {
				count += sessions.size;
			}
		}

		return {
			version: v.version,
			algorithm: v.algorithm,
			auth_data: v.auth_data,
			count,
			etag: this.computeBackupEtag(backupKey),
		};
	}

	private computeBackupEtag(backupKey: string): string {
		const rooms = this.keyBackupData.get(backupKey);
		if (!rooms) return "0";
		let hash = 0;
		for (const [roomId, sessions] of rooms) {
			for (const sessionId of sessions.keys()) {
				for (const c of `${roomId}${sessionId}`) {
					hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
				}
			}
		}
		return String(Math.abs(hash));
	}

	async updateKeyBackupVersion(
		userId: UserId,
		version: string,
		authData: JsonObject,
	): Promise<boolean> {
		const versions = this.keyBackupVersions.get(userId);
		if (!versions) return false;
		const v = versions.find((b) => b.version === version);
		if (!v) return false;
		v.auth_data = authData;
		return true;
	}

	async deleteKeyBackupVersion(
		userId: UserId,
		version: string,
	): Promise<boolean> {
		const versions = this.keyBackupVersions.get(userId);
		if (!versions) return false;
		const idx = versions.findIndex((b) => b.version === version);
		if (idx === -1) return false;
		versions.splice(idx, 1);
		this.keyBackupData.delete(`${userId}\x1f${version}`);
		return true;
	}

	async putKeyBackupKeys(
		userId: UserId,
		version: string,
		roomId: RoomId | undefined,
		sessionId: string | undefined,
		keys:
			| KeyBackupData
			| { sessions: Record<string, KeyBackupData> }
			| {
					rooms: Record<RoomId, { sessions: Record<string, KeyBackupData> }>;
			  },
	): Promise<{ count: number; etag: string } | undefined> {
		const versions = this.keyBackupVersions.get(userId);
		if (!versions || versions.length === 0) return undefined;
		const current = versions[versions.length - 1]!;
		if (current.version !== version) return undefined;

		const backupKey = `${userId}\x1f${version}`;
		let rooms = this.keyBackupData.get(backupKey);
		if (!rooms) {
			rooms = new Map();
			this.keyBackupData.set(backupKey, rooms);
		}

		if (roomId && sessionId) {
			// Single session
			const data = keys as KeyBackupData;
			this.mergeBackupKey(rooms, roomId, sessionId, data);
		} else if (roomId) {
			// Room sessions
			const roomKeys = keys as { sessions: Record<string, KeyBackupData> };
			for (const [sid, data] of Object.entries(roomKeys.sessions)) {
				this.mergeBackupKey(rooms, roomId, sid, data);
			}
		} else {
			// All rooms
			const allKeys = keys as {
				rooms: Record<RoomId, { sessions: Record<string, KeyBackupData> }>;
			};
			for (const [rid, roomData] of Object.entries(allKeys.rooms)) {
				for (const [sid, data] of Object.entries(roomData.sessions)) {
					this.mergeBackupKey(rooms, rid as RoomId, sid, data);
				}
			}
		}

		let count = 0;
		for (const sessions of rooms.values()) count += sessions.size;
		return { count, etag: this.computeBackupEtag(backupKey) };
	}

	private mergeBackupKey(
		rooms: Map<RoomId, Map<string, KeyBackupData>>,
		roomId: RoomId,
		sessionId: string,
		newData: KeyBackupData,
	): void {
		let sessions = rooms.get(roomId);
		if (!sessions) {
			sessions = new Map();
			rooms.set(roomId, sessions);
		}
		const existing = sessions.get(sessionId);
		if (existing) {
			// Merge: prefer verified, then lower first_message_index, then lower forwarded_count
			if (
				(newData.is_verified && !existing.is_verified) ||
				(newData.is_verified === existing.is_verified &&
					newData.first_message_index < existing.first_message_index) ||
				(newData.is_verified === existing.is_verified &&
					newData.first_message_index === existing.first_message_index &&
					newData.forwarded_count < existing.forwarded_count)
			) {
				sessions.set(sessionId, newData);
			}
		} else {
			sessions.set(sessionId, newData);
		}
	}

	async getKeyBackupKeys(
		userId: UserId,
		version: string,
		roomId?: RoomId,
		sessionId?: string,
	): Promise<
		| KeyBackupData
		| { sessions: Record<string, KeyBackupData> }
		| {
				rooms: Record<RoomId, { sessions: Record<string, KeyBackupData> }>;
		  }
		| undefined
	> {
		const backupKey = `${userId}\x1f${version}`;
		const rooms = this.keyBackupData.get(backupKey);

		if (roomId && sessionId) {
			const sessions = rooms?.get(roomId);
			return sessions?.get(sessionId);
		} else if (roomId) {
			const sessions = rooms?.get(roomId);
			const result: Record<string, KeyBackupData> = {};
			if (sessions) {
				for (const [sid, data] of sessions) result[sid] = data;
			}
			return { sessions: result };
		} else {
			const result: Record<
				RoomId,
				{ sessions: Record<string, KeyBackupData> }
			> = {};
			if (rooms) {
				for (const [rid, sessions] of rooms) {
					const sessionsObj: Record<string, KeyBackupData> = {};
					for (const [sid, data] of sessions) sessionsObj[sid] = data;
					result[rid] = { sessions: sessionsObj };
				}
			}
			return { rooms: result };
		}
	}

	async deleteKeyBackupKeys(
		userId: UserId,
		version: string,
		roomId?: RoomId,
		sessionId?: string,
	): Promise<{ count: number; etag: string } | undefined> {
		const versions = this.keyBackupVersions.get(userId);
		if (!versions || !versions.some((v) => v.version === version))
			return undefined;

		const backupKey = `${userId}\x1f${version}`;
		const rooms = this.keyBackupData.get(backupKey);
		if (!rooms) return { count: 0, etag: "0" };

		if (roomId && sessionId) {
			const sessions = rooms.get(roomId);
			if (sessions) {
				sessions.delete(sessionId);
				if (sessions.size === 0) rooms.delete(roomId);
			}
		} else if (roomId) {
			rooms.delete(roomId);
		} else {
			rooms.clear();
		}

		let count = 0;
		for (const sessions of rooms.values()) count += sessions.size;
		return { count, etag: this.computeBackupEtag(backupKey) };
	}

	async sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void> {
		const key = `${userId}\x1f${deviceId}`;
		let inbox = this.toDeviceInbox.get(key);
		if (!inbox) {
			inbox = [];
			this.toDeviceInbox.set(key, inbox);
		}
		inbox.push(event);
		this.wakeWaiters();
	}

	async getToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<ToDeviceEvent[]> {
		return this.toDeviceInbox.get(`${userId}\x1f${deviceId}`) ?? [];
	}

	async clearToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<void> {
		this.toDeviceInbox.delete(`${userId}\x1f${deviceId}`);
	}

	async getPushers(userId: UserId): Promise<Pusher[]> {
		return this.pushersMap.get(userId) ?? [];
	}

	async setPusher(userId: UserId, pusher: Pusher): Promise<void> {
		let userPushers = this.pushersMap.get(userId);
		if (!userPushers) {
			userPushers = [];
			this.pushersMap.set(userId, userPushers);
		}
		const idx = userPushers.findIndex(
			(p) => p.app_id === pusher.app_id && p.pushkey === pusher.pushkey,
		);
		if (idx >= 0) {
			userPushers[idx] = pusher;
		} else {
			userPushers.push(pusher);
		}
	}

	async deletePusher(
		userId: UserId,
		appId: string,
		pushkey: string,
	): Promise<void> {
		const userPushers = this.pushersMap.get(userId);
		if (!userPushers) return;
		const idx = userPushers.findIndex(
			(p) => p.app_id === appId && p.pushkey === pushkey,
		);
		if (idx >= 0) userPushers.splice(idx, 1);
	}

	async deletePusherByKey(appId: string, pushkey: string): Promise<void> {
		for (const [, userPushers] of this.pushersMap) {
			const idx = userPushers.findIndex(
				(p) => p.app_id === appId && p.pushkey === pushkey,
			);
			if (idx >= 0) userPushers.splice(idx, 1);
		}
	}

	async storeRelation(
		eventId: EventId,
		roomId: RoomId,
		relType: string,
		targetEventId: EventId,
		key?: string,
	): Promise<void> {
		const event = this.events.get(eventId);
		if (!event) return;

		const timeline = this.roomTimeline.get(roomId) ?? [];
		const streamPos =
			timeline.find((e) => e.eventId === eventId)?.streamPos ??
			this.streamCounter;

		let relations = this.relationsMap.get(targetEventId);
		if (!relations) {
			relations = [];
			this.relationsMap.set(targetEventId, relations);
		}
		relations.push({
			eventId,
			relType,
			key,
			sender: event.sender,
			eventType: event.type,
			streamPos,
		});
	}

	async getRelatedEvents(
		roomId: RoomId,
		eventId: EventId,
		relType?: string,
		eventType?: string,
		limit: number = 50,
		from?: string,
		direction: "b" | "f" = "f",
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		nextBatch?: string;
	}> {
		let relations = this.relationsMap.get(eventId) ?? [];

		if (relType) relations = relations.filter((r) => r.relType === relType);
		if (eventType)
			relations = relations.filter((r) => r.eventType === eventType);

		relations = [...relations].sort((a, b) =>
			direction === "f" ? a.streamPos - b.streamPos : b.streamPos - a.streamPos,
		);

		const fromPos = from ? parseInt(from, 10) : undefined;
		if (fromPos !== undefined) {
			const startIdx = relations.findIndex((r) =>
				direction === "f" ? r.streamPos > fromPos : r.streamPos < fromPos,
			);
			relations = startIdx >= 0 ? relations.slice(startIdx) : [];
		}

		const sliced = relations.slice(0, limit);
		const events = sliced
			.map((r) => {
				const event = this.events.get(r.eventId);
				if (!event || event.room_id !== roomId) return undefined;
				return { event, eventId: r.eventId };
			})
			.filter((e): e is { event: PDU; eventId: EventId } => e !== undefined);

		const nextBatch =
			sliced.length === limit && sliced.length > 0
				? String(sliced[sliced.length - 1]?.streamPos)
				: undefined;

		return { events, nextBatch };
	}

	async getAnnotationCounts(
		eventId: EventId,
	): Promise<{ type: string; key: string; count: number }[]> {
		const annotations = (this.relationsMap.get(eventId) ?? []).filter(
			(r) => r.relType === "m.annotation" && r.key,
		);

		const counts = new Map<
			string,
			{ type: string; key: string; count: number }
		>();
		for (const ann of annotations) {
			const mapKey = `${ann.eventType}\x1f${ann.key}`;
			const existing = counts.get(mapKey);
			if (existing) {
				existing.count++;
			} else {
				counts.set(mapKey, {
					type: ann.eventType,
					key: ann.key as string,
					count: 1,
				});
			}
		}
		return [...counts.values()];
	}

	async getLatestEdit(
		eventId: EventId,
		sender: UserId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const edits = (this.relationsMap.get(eventId) ?? [])
			.filter((r) => r.relType === "m.replace" && r.sender === sender)
			.sort((a, b) => b.streamPos - a.streamPos);

		if (edits.length === 0) return undefined;
		const latest = edits[0] as (typeof edits)[number];
		const event = this.events.get(latest.eventId);
		if (!event) return undefined;
		return { event, eventId: latest.eventId };
	}

	async getThreadSummary(
		eventId: EventId,
		userId: UserId,
	): Promise<
		| {
				latestEvent: { event: PDU; eventId: EventId };
				count: number;
				currentUserParticipated: boolean;
		  }
		| undefined
	> {
		const threadReplies = (this.relationsMap.get(eventId) ?? [])
			.filter((r) => r.relType === "m.thread")
			.sort((a, b) => a.streamPos - b.streamPos);

		if (threadReplies.length === 0) return undefined;

		const latest = threadReplies[
			threadReplies.length - 1
		] as (typeof threadReplies)[number];
		const latestEvent = this.events.get(latest.eventId);
		if (!latestEvent) return undefined;

		return {
			latestEvent: { event: latestEvent, eventId: latest.eventId },
			count: threadReplies.length,
			currentUserParticipated: threadReplies.some((r) => r.sender === userId),
		};
	}

	async storeReport(
		userId: UserId,
		roomId: RoomId,
		eventId: EventId,
		score?: number,
		reason?: string,
	): Promise<void> {
		this.reports.push({
			userId,
			roomId,
			eventId,
			score,
			reason,
			ts: Date.now(),
		});
	}

	async storeOpenIdToken(
		token: string,
		userId: UserId,
		expiresAt: number,
	): Promise<void> {
		this.openIdTokens.set(token, { userId, expiresAt });
	}

	async getOpenIdToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: number } | undefined> {
		return this.openIdTokens.get(token);
	}

	async getThreePids(
		userId: UserId,
	): Promise<{ medium: string; address: string; added_at: number }[]> {
		return this.threePidsMap.get(userId) ?? [];
	}

	async addThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		let pids = this.threePidsMap.get(userId);
		if (!pids) {
			pids = [];
			this.threePidsMap.set(userId, pids);
		}
		if (pids.some((p) => p.medium === medium && p.address === address)) return;
		pids.push({ medium, address, added_at: Date.now() });
	}

	async deleteThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		const pids = this.threePidsMap.get(userId);
		if (!pids) return;
		const idx = pids.findIndex(
			(p) => p.medium === medium && p.address === address,
		);
		if (idx >= 0) pids.splice(idx, 1);
	}

	async searchUserDirectory(
		searchTerm: string,
		limit: number,
	): Promise<
		{ user_id: UserId; display_name?: string; avatar_url?: string }[]
	> {
		const term = searchTerm.toLowerCase();
		const results: {
			user_id: UserId;
			display_name?: string;
			avatar_url?: string;
		}[] = [];
		for (const user of this.usersByFullId.values()) {
			if (user.is_deactivated) continue;
			const matchId = user.user_id.toLowerCase().includes(term);
			const matchName = user.displayname?.toLowerCase().includes(term) ?? false;
			if (matchId || matchName) {
				results.push({
					user_id: user.user_id,
					display_name: user.displayname,
					avatar_url: user.avatar_url,
				});
			}
			if (results.length >= limit) break;
		}
		return results;
	}

	async getThreadRoots(
		roomId: RoomId,
		userId: UserId,
		include: "all" | "participated",
		limit: number,
		from?: string,
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		nextBatch?: string;
	}> {
		const threadRoots = new Map<EventId, number>();
		const participatedIn = new Set<EventId>();

		for (const [targetId, relations] of this.relationsMap) {
			const threadReplies = relations.filter((r) => r.relType === "m.thread");
			if (threadReplies.length === 0) continue;

			const targetEvent = this.events.get(targetId);
			if (!targetEvent || targetEvent.room_id !== roomId) continue;

			threadRoots.set(
				targetId,
				Math.max(...threadReplies.map((r) => r.streamPos)),
			);

			if (threadReplies.some((r) => r.sender === userId)) {
				participatedIn.add(targetId);
			}
		}

		let rootIds = [...threadRoots.entries()];
		if (include === "participated") {
			rootIds = rootIds.filter(([id]) => participatedIn.has(id));
		}

		rootIds.sort((a, b) => b[1] - a[1]);

		if (from) {
			const fromPos = parseInt(from, 10);
			const startIdx = rootIds.findIndex(([, pos]) => pos < fromPos);
			rootIds = startIdx >= 0 ? rootIds.slice(startIdx) : [];
		}

		const sliced = rootIds.slice(0, limit);
		const events = sliced
			.map(([eventId]) => {
				const event = this.events.get(eventId);
				if (!event) return undefined;
				return { event, eventId };
			})
			.filter((e): e is { event: PDU; eventId: EventId } => e !== undefined);

		const nextBatch =
			sliced.length === limit && sliced.length > 0
				? String(sliced[sliced.length - 1]?.[1])
				: undefined;

		return { events, nextBatch };
	}

	async searchRoomEvents(
		roomIds: RoomId[],
		searchTerm: string,
		keys: string[],
		limit: number,
		from?: string,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		count: number;
		nextBatch?: string;
	}> {
		const allEntries = roomIds.flatMap(
			(roomId) => this.roomTimeline.get(roomId) ?? [],
		);
		allEntries.sort((a, b) => b.streamPos - a.streamPos);

		const allMatches: { event: PDU; eventId: EventId; streamPos: number }[] =
			[];
		for (const entry of allEntries) {
			const event = this.events.get(entry.eventId);
			if (!event) continue;
			if (eventMatchesSearchTerm(event, keys, searchTerm)) {
				allMatches.push({
					event,
					eventId: entry.eventId,
					streamPos: entry.streamPos,
				});
			}
		}

		return paginateSearchMatches(allMatches, limit, from);
	}

	async storeServerKeys(
		serverName: ServerName,
		keys: ServerKeys,
	): Promise<void> {
		for (const [keyId, val] of Object.entries(keys.verify_keys)) {
			this.serverKeysCache.set(`${serverName}\x1f${keyId}`, {
				key: val.key,
				validUntil: keys.valid_until_ts,
			});
		}
	}

	async getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined> {
		return this.serverKeysCache.get(`${serverName}\x1f${keyId}`);
	}

	async getAuthChain(eventIds: EventId[]): Promise<PDU[]> {
		const visited = new Set<EventId>();
		const result: PDU[] = [];
		const queue = [...eventIds];

		while (queue.length > 0) {
			const id = queue.shift() as EventId;
			if (visited.has(id)) continue;
			visited.add(id);

			const event = this.events.get(id);
			if (!event) continue;
			result.push(event);

			for (const authId of event.auth_events) {
				if (!visited.has(authId)) {
					queue.push(authId);
				}
			}
		}

		return result;
	}

	async getServersInRoom(roomId: RoomId): Promise<ServerName[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];

		const servers = new Set<ServerName>();
		for (const [key, event] of room.state_events) {
			if (key.startsWith("m.room.member\x1f")) {
				const membership = (event.content as Record<string, unknown>)
					.membership;
				// Include servers of any join/invite/knock member so that
				// federation fanout reaches invited and knocking participants.
				if (
					membership === "join" ||
					membership === "invite" ||
					membership === "knock"
				) {
					servers.add(
						(event.state_key as string)
							.split(":")
							.slice(1)
							.join(":") as ServerName,
					);
				}
			}
		}

		return [...servers];
	}

	async getStateAtEvent(
		_roomId: RoomId,
		_eventId: EventId,
	): Promise<Map<string, PDU> | undefined> {
		const room = this.rooms.get(_roomId);
		if (!room) return undefined;
		return new Map(room.state_events);
	}

	async getFederationTxn(origin: ServerName, txnId: string): Promise<boolean> {
		return this.federationTxns.has(`${origin}\x1f${txnId}`);
	}

	async setFederationTxn(origin: ServerName, txnId: string): Promise<void> {
		this.federationTxns.add(`${origin}\x1f${txnId}`);
	}

	async enqueueFederationEdu(
		destination: ServerName,
		edu: EDU,
	): Promise<number> {
		const id = ++this.pendingFederationEduCounter;
		const queue = this.pendingFederationEdus.get(destination) ?? [];
		queue.push({ id, edu });
		// Cap the per-destination queue; drop the oldest entries on overflow.
		if (queue.length > PENDING_FEDERATION_EDU_CAP) {
			const dropped = queue.splice(
				0,
				queue.length - PENDING_FEDERATION_EDU_CAP,
			);
			console.warn(
				`pendingFederationEdus: dropped ${dropped.length} EDU(s) for ${destination} (queue cap ${PENDING_FEDERATION_EDU_CAP} exceeded)`,
			);
		}
		this.pendingFederationEdus.set(destination, queue);
		return id;
	}

	async getPendingFederationEdus(
		destination: ServerName,
		limit: number,
	): Promise<{ id: number; edu: EDU }[]> {
		const queue = this.pendingFederationEdus.get(destination) ?? [];
		return queue.slice(0, limit).map((e) => ({ id: e.id, edu: e.edu }));
	}

	async deleteFederationEdu(id: number): Promise<void> {
		for (const [dest, queue] of this.pendingFederationEdus) {
			const idx = queue.findIndex((e) => e.id === id);
			if (idx !== -1) {
				queue.splice(idx, 1);
				if (queue.length === 0) this.pendingFederationEdus.delete(dest);
				return;
			}
		}
	}

	async getPendingFederationDestinations(): Promise<ServerName[]> {
		return [...this.pendingFederationEdus.keys()];
	}

	async storeVerificationToken(
		sessionId: string,
		data: {
			medium: string;
			address: string;
			clientSecret: string;
			sendAttempt: number;
			token: string;
			validated: boolean;
			userId?: string;
		},
	): Promise<void> {
		this.verificationSessions.set(sessionId, { ...data });
	}

	async getVerificationSession(sessionId: string): Promise<
		| {
				medium: string;
				address: string;
				clientSecret: string;
				sendAttempt: number;
				token: string;
				validated: boolean;
				userId?: string;
		  }
		| undefined
	> {
		return this.verificationSessions.get(sessionId);
	}

	async validateVerificationToken(
		sessionId: string,
		token: string,
	): Promise<boolean> {
		const session = this.verificationSessions.get(sessionId);
		if (!session) return false;
		if (session.token !== token) return false;
		session.validated = true;
		return true;
	}

	async storeLoginToken(
		token: string,
		userId: UserId,
		expiresAt: number,
	): Promise<void> {
		this.loginTokens.set(token, { userId, expiresAt });
	}

	async getLoginToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: number } | undefined> {
		return this.loginTokens.get(token);
	}

	async deleteLoginToken(token: string): Promise<void> {
		this.loginTokens.delete(token);
	}

	async importRoomState(
		roomId: RoomId,
		roomVersion: RoomVersion,
		stateEvents: PDU[],
		authChain: PDU[],
	): Promise<void> {
		for (const event of authChain) {
			this.events.set(computeEventId(event, roomVersion), event);
		}

		const stateMap = new Map<string, PDU>();
		let maxDepth = 0;
		const extremities: EventId[] = [];

		for (const event of stateEvents) {
			const eventId = computeEventId(event, roomVersion);
			this.events.set(eventId, event);

			stateMap.set(`${event.type}\x1f${event.state_key ?? ""}`, event);

			const timeline = this.roomTimeline.get(roomId) ?? [];
			this.streamCounter++;
			timeline.push({ eventId, streamPos: this.streamCounter });
			this.roomTimeline.set(roomId, timeline);

			if (event.depth > maxDepth) maxDepth = event.depth;
			extremities.length = 0;
			extremities.push(eventId);
		}

		this.rooms.set(roomId, {
			room_id: roomId,
			room_version: roomVersion,
			state_events: stateMap,
			depth: maxDepth + 1,
			forward_extremities: extremities,
		});

		this.wakeWaiters();
	}
}
