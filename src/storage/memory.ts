import { computeEventId } from "../events.ts";
import type { DeviceKeys, OneTimeKey } from "../types/e2ee.ts";
import type { PresenceState } from "../types/ephemeral.ts";
import type {
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
import type { Storage, StoredSession } from "./interface.ts";

export class MemoryStorage implements Storage {
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
	private streamCounter = 0;
	private txnMap = new Map<string, EventId>();
	private eventWaiters = new Set<() => void>();
	private aliases = new Map<
		RoomAlias,
		{ room_id: RoomId; servers: ServerName[]; creator: UserId }
	>();
	private publicRooms = new Set<RoomId>();
	private globalAccountData = new Map<UserId, Map<string, JsonObject>>();
	private roomAccountDataMap = new Map<string, Map<string, JsonObject>>();
	private typingTimers = new Map<
		RoomId,
		Map<UserId, ReturnType<typeof setTimeout>>
	>();
	private receiptsMap = new Map<
		RoomId,
		Map<string, { eventId: EventId; ts: Timestamp }>
	>();
	private presenceMap = new Map<
		UserId,
		{ presence: PresenceState; status_msg?: string; last_active_ts?: Timestamp }
	>();
	private mediaStore = new Map<
		string,
		{ metadata: StoredMedia; data: Buffer }
	>();
	private filters = new Map<UserId, Map<string, JsonObject>>();
	private filterCounter = 0;
	private deviceKeysMap = new Map<string, DeviceKeys>();
	private oneTimeKeysMap = new Map<string, Map<KeyId, string | OneTimeKey>>();
	private fallbackKeysMap = new Map<string, Map<KeyId, string | OneTimeKey>>();
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
				const memberEvent = room.state_events.get(`m.room.member\0${userId}`);
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
		for (const waiter of this.eventWaiters) {
			waiter();
		}
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
		const event = this.rooms
			.get(roomId)
			?.state_events.get(`${eventType}\0${stateKey}`);
		if (!event) return undefined;
		return { event, eventId: computeEventId(event) };
	}

	async getAllState(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];
		return [...room.state_events.values()].map((event) => ({
			event,
			eventId: computeEventId(event),
		}));
	}

	async setStateEvent(
		roomId: RoomId,
		event: PDU,
		eventId: EventId,
	): Promise<void> {
		const room = this.rooms.get(roomId);
		if (!room) return;
		room.state_events.set(`${event.type}\0${event.state_key ?? ""}`, event);
		await this.storeEvent(event, eventId);
	}

	async getMemberEvents(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const room = this.rooms.get(roomId);
		if (!room) return [];
		return [...room.state_events.entries()]
			.filter(([key]) => key.startsWith("m.room.member\0"))
			.map(([, event]) => ({ event, eventId: computeEventId(event) }));
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
				const memberEvent = room.state_events.get(`m.room.member\0${userId}`);
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
		const INVITE_STATE_TYPES = new Set([
			"m.room.create",
			"m.room.join_rules",
			"m.room.canonical_alias",
			"m.room.avatar",
			"m.room.name",
			"m.room.encryption",
		]);
		return [...room.state_events.entries()]
			.filter(([key]) => {
				const type = key.split("\0")[0] as string;
				return INVITE_STATE_TYPES.has(type) || type === "m.room.member";
			})
			.map(([, event]) => ({
				content: event.content,
				sender: event.sender,
				state_key: event.state_key ?? "",
				type: event.type,
			}));
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
		return this.globalAccountData.get(userId)?.get(type);
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
		userMap.set(type, content);
	}

	async getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const userMap = this.globalAccountData.get(userId);
		if (!userMap) return [];
		return [...userMap.entries()].map(([type, content]) => ({ type, content }));
	}

	async getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined> {
		return this.roomAccountDataMap.get(`${userId}\0${roomId}`)?.get(type);
	}

	async setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		const key = `${userId}\0${roomId}`;
		let dataMap = this.roomAccountDataMap.get(key);
		if (!dataMap) {
			dataMap = new Map();
			this.roomAccountDataMap.set(key, dataMap);
		}
		dataMap.set(type, content);
	}

	async getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const dataMap = this.roomAccountDataMap.get(`${userId}\0${roomId}`);
		if (!dataMap) return [];
		return [...dataMap.entries()].map(([type, content]) => ({ type, content }));
	}

	private wakeWaiters(): void {
		for (const waiter of this.eventWaiters) {
			waiter();
		}
	}

	async setTyping(
		roomId: RoomId,
		userId: UserId,
		typing: boolean,
		timeout?: number,
	): Promise<void> {
		let roomTyping = this.typingTimers.get(roomId);
		if (!roomTyping) {
			roomTyping = new Map();
			this.typingTimers.set(roomId, roomTyping);
		}

		const existing = roomTyping.get(userId);
		if (existing) {
			clearTimeout(existing);
			roomTyping.delete(userId);
		}

		if (typing) {
			const ms = Math.min(timeout ?? 30000, 120000);
			const timer = setTimeout(() => {
				roomTyping?.delete(userId);
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

	async setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
	): Promise<void> {
		let roomReceipts = this.receiptsMap.get(roomId);
		if (!roomReceipts) {
			roomReceipts = new Map();
			this.receiptsMap.set(roomId, roomReceipts);
		}
		roomReceipts.set(`${userId}\0${receiptType}`, { eventId, ts });
		this.wakeWaiters();
	}

	async getReceipts(
		roomId: RoomId,
	): Promise<
		{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]
	> {
		const roomReceipts = this.receiptsMap.get(roomId);
		if (!roomReceipts) return [];
		return [...roomReceipts.entries()].map(([key, value]) => {
			const [userId, receiptType] = key.split("\0") as [UserId, string];
			return { eventId: value.eventId, receiptType, userId, ts: value.ts };
		});
	}

	async setPresence(
		userId: UserId,
		presence: PresenceState,
		statusMsg?: string,
	): Promise<void> {
		this.presenceMap.set(userId, {
			presence,
			status_msg: statusMsg,
			last_active_ts: Date.now(),
		});
		this.wakeWaiters();
	}

	async getPresence(userId: UserId): Promise<
		| {
				presence: PresenceState;
				status_msg?: string;
				last_active_ts?: Timestamp;
		  }
		| undefined
	> {
		return this.presenceMap.get(userId);
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
		this.deviceKeysMap.set(`${userId}\0${deviceId}`, keys);
	}

	async getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined> {
		return this.deviceKeysMap.get(`${userId}\0${deviceId}`);
	}

	async getAllDeviceKeys(
		userId: UserId,
	): Promise<Record<DeviceId, DeviceKeys>> {
		const result: Record<DeviceId, DeviceKeys> = {};
		const prefix = `${userId}\0`;
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
		const mapKey = `${userId}\0${deviceId}`;
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
		const mapKey = `${userId}\0${deviceId}`;
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
		const otks = this.oneTimeKeysMap.get(`${userId}\0${deviceId}`);
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
		this.fallbackKeysMap.set(`${userId}\0${deviceId}`, fallbacks);
	}

	async getFallbackKeyTypes(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<string[]> {
		const fallbacks = this.fallbackKeysMap.get(`${userId}\0${deviceId}`);
		if (!fallbacks) return [];
		return [
			...new Set(
				[...fallbacks.keys()].map((keyId) => keyId.split(":")[0] as string),
			),
		];
	}

	async sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void> {
		const key = `${userId}\0${deviceId}`;
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
		return this.toDeviceInbox.get(`${userId}\0${deviceId}`) ?? [];
	}

	async clearToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<void> {
		this.toDeviceInbox.delete(`${userId}\0${deviceId}`);
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
			const mapKey = `${ann.eventType}\0${ann.key}`;
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
		nextBatch?: string;
	}> {
		const term = searchTerm.toLowerCase();
		const results: { event: PDU; eventId: EventId; streamPos: number }[] = [];
		const fromPos = from ? parseInt(from, 10) : undefined;

		const allEntries = roomIds.flatMap((roomId) => {
			const timeline = this.roomTimeline.get(roomId) ?? [];
			return fromPos !== undefined
				? timeline.filter((entry) => entry.streamPos < fromPos)
				: timeline;
		});
		allEntries.sort((a, b) => b.streamPos - a.streamPos);

		for (const entry of allEntries) {
			if (results.length >= limit) break;

			const event = this.events.get(entry.eventId);
			if (!event) continue;

			const content = event.content as Record<string, unknown>;
			const matched = keys.some((key) => {
				const field =
					key === "content.body"
						? content.body
						: key === "content.name"
							? content.name
							: key === "content.topic"
								? content.topic
								: undefined;
				return typeof field === "string" && field.toLowerCase().includes(term);
			});

			if (matched) {
				results.push({
					event,
					eventId: entry.eventId,
					streamPos: entry.streamPos,
				});
			}
		}

		const nextBatch =
			results.length === limit && results.length > 0
				? String(results[results.length - 1]?.streamPos)
				: undefined;

		return { events: results, nextBatch };
	}

	async storeServerKeys(
		serverName: ServerName,
		keys: ServerKeys,
	): Promise<void> {
		for (const [keyId, val] of Object.entries(keys.verify_keys)) {
			this.serverKeysCache.set(`${serverName}\0${keyId}`, {
				key: val.key,
				validUntil: keys.valid_until_ts,
			});
		}
	}

	async getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined> {
		return this.serverKeysCache.get(`${serverName}\0${keyId}`);
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
			if (key.startsWith("m.room.member\0")) {
				if ((event.content as Record<string, unknown>).membership === "join") {
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
		return this.federationTxns.has(`${origin}\0${txnId}`);
	}

	async setFederationTxn(origin: ServerName, txnId: string): Promise<void> {
		this.federationTxns.add(`${origin}\0${txnId}`);
	}

	async importRoomState(
		roomId: RoomId,
		roomVersion: RoomVersion,
		stateEvents: PDU[],
		authChain: PDU[],
	): Promise<void> {
		for (const event of authChain) {
			this.events.set(computeEventId(event), event);
		}

		const stateMap = new Map<string, PDU>();
		let maxDepth = 0;
		const extremities: EventId[] = [];

		for (const event of stateEvents) {
			const eventId = computeEventId(event);
			this.events.set(eventId, event);

			stateMap.set(`${event.type}\0${event.state_key ?? ""}`, event);

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

		for (const waiter of this.eventWaiters) waiter();
		this.eventWaiters.clear();
	}
}
