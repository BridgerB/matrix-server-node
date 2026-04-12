import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { computeEventId } from "../events.ts";
import type { DeviceKeys, OneTimeKey } from "../types/e2ee.ts";
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
import {
	EphemeralMixin,
	eventToStrippedState,
	INVITE_STATE_TYPES,
} from "./ephemeral.ts";
import type { Storage, StoredSession } from "./interface.ts";
import { rowToSession, rowToUser } from "./sql-helpers.ts";

export class SqliteStorage extends EphemeralMixin implements Storage {
	private db: Database.Database;

	// Room state cache — the handler relies on setStateEvent mutating
	// the same RoomState reference that ctx.roomState holds

	private stmts!: {
		insertEvent: Database.Statement;
		getEvent: Database.Statement;
		insertTimelineEntry: Database.Statement;
		getSession: Database.Statement;
		insertSession: Database.Statement;
		insertStateEvent: Database.Statement;
		getStateEvent: Database.Statement;
		getTxn: Database.Statement;
		setTxn: Database.Statement;
	};

	constructor(dbPath: string) {
		super();
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.pragma("foreign_keys = OFF");
		this.init();
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS users (
				user_id TEXT PRIMARY KEY,
				localpart TEXT UNIQUE NOT NULL,
				server_name TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				account_type TEXT NOT NULL DEFAULT 'user',
				is_deactivated INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				displayname TEXT,
				avatar_url TEXT
			);

			CREATE TABLE IF NOT EXISTS sessions (
				access_token TEXT PRIMARY KEY,
				refresh_token TEXT,
				device_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				access_token_hash TEXT,
				expires_at INTEGER,
				display_name TEXT,
				last_seen_ip TEXT,
				last_seen_ts INTEGER,
				user_agent TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
			CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token);
			CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(user_id, device_id);

			CREATE TABLE IF NOT EXISTS uiaa_sessions (
				session_id TEXT PRIMARY KEY,
				completed TEXT NOT NULL DEFAULT '[]'
			);

			CREATE TABLE IF NOT EXISTS rooms (
				room_id TEXT PRIMARY KEY,
				room_version TEXT NOT NULL,
				depth INTEGER NOT NULL DEFAULT 0,
				forward_extremities TEXT NOT NULL DEFAULT '[]'
			);

			CREATE TABLE IF NOT EXISTS events (
				event_id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				stream_pos INTEGER NOT NULL,
				event_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id);
			CREATE INDEX IF NOT EXISTS idx_events_stream ON events(room_id, stream_pos);

			CREATE TABLE IF NOT EXISTS state_events (
				room_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				state_key TEXT NOT NULL,
				event_id TEXT NOT NULL,
				event_json TEXT NOT NULL,
				PRIMARY KEY (room_id, event_type, state_key)
			);

			CREATE TABLE IF NOT EXISTS txn_map (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				txn_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				PRIMARY KEY (user_id, device_id, txn_id)
			);

			CREATE TABLE IF NOT EXISTS room_aliases (
				room_alias TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				servers TEXT NOT NULL DEFAULT '[]',
				creator TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS room_directory (
				room_id TEXT PRIMARY KEY,
				visibility TEXT NOT NULL DEFAULT 'private'
			);

			CREATE TABLE IF NOT EXISTS global_account_data (
				user_id TEXT NOT NULL,
				type TEXT NOT NULL,
				content TEXT NOT NULL,
				PRIMARY KEY (user_id, type)
			);

			CREATE TABLE IF NOT EXISTS room_account_data (
				user_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				type TEXT NOT NULL,
				content TEXT NOT NULL,
				PRIMARY KEY (user_id, room_id, type)
			);

			CREATE TABLE IF NOT EXISTS receipts (
				room_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				receipt_type TEXT NOT NULL,
				ts INTEGER NOT NULL,
				PRIMARY KEY (room_id, user_id, receipt_type)
			);

			CREATE TABLE IF NOT EXISTS media (
				origin TEXT NOT NULL,
				media_id TEXT NOT NULL,
				user_id TEXT,
				content_type TEXT NOT NULL,
				upload_name TEXT,
				file_size INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				quarantined INTEGER NOT NULL DEFAULT 0,
				data BLOB NOT NULL,
				PRIMARY KEY (origin, media_id)
			);

			CREATE TABLE IF NOT EXISTS filters (
				user_id TEXT NOT NULL,
				filter_id TEXT NOT NULL,
				filter_json TEXT NOT NULL,
				PRIMARY KEY (user_id, filter_id)
			);

			CREATE TABLE IF NOT EXISTS device_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				keys_json TEXT NOT NULL,
				PRIMARY KEY (user_id, device_id)
			);

			CREATE TABLE IF NOT EXISTS one_time_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				key_id TEXT NOT NULL,
				algorithm TEXT NOT NULL,
				key_json TEXT NOT NULL,
				PRIMARY KEY (user_id, device_id, key_id)
			);

			CREATE TABLE IF NOT EXISTS fallback_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				key_id TEXT NOT NULL,
				key_json TEXT NOT NULL,
				PRIMARY KEY (user_id, device_id, key_id)
			);

			CREATE TABLE IF NOT EXISTS to_device (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				event_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_to_device ON to_device(user_id, device_id);

			CREATE TABLE IF NOT EXISTS pushers (
				user_id TEXT NOT NULL,
				app_id TEXT NOT NULL,
				pushkey TEXT NOT NULL,
				pusher_json TEXT NOT NULL,
				PRIMARY KEY (user_id, app_id, pushkey)
			);

			CREATE TABLE IF NOT EXISTS relations (
				event_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				rel_type TEXT NOT NULL,
				target_event_id TEXT NOT NULL,
				key TEXT,
				sender TEXT NOT NULL,
				event_type TEXT NOT NULL,
				stream_pos INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_event_id);

			CREATE TABLE IF NOT EXISTS reports (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				score INTEGER,
				reason TEXT,
				ts INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS openid_tokens (
				token TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS threepids (
				user_id TEXT NOT NULL,
				medium TEXT NOT NULL,
				address TEXT NOT NULL,
				added_at INTEGER NOT NULL,
				PRIMARY KEY (user_id, medium, address)
			);

			CREATE TABLE IF NOT EXISTS server_keys (
				server_name TEXT NOT NULL,
				key_id TEXT NOT NULL,
				key TEXT NOT NULL,
				valid_until INTEGER NOT NULL,
				PRIMARY KEY (server_name, key_id)
			);

			CREATE TABLE IF NOT EXISTS federation_txns (
				origin TEXT NOT NULL,
				txn_id TEXT NOT NULL,
				PRIMARY KEY (origin, txn_id)
			);
		`);

		const maxPos = this.db
			.prepare("SELECT MAX(stream_pos) as m FROM events")
			.get() as { m: number | null } | undefined;
		this.streamCounter = maxPos?.m ?? 0;

		const maxFilter = this.db
			.prepare("SELECT MAX(CAST(filter_id AS INTEGER)) as m FROM filters")
			.get() as { m: number | null } | undefined;
		this.filterCounter = maxFilter?.m ?? 0;

		this.stmts = {
			insertEvent: this.db.prepare(
				"INSERT OR REPLACE INTO events (event_id, room_id, stream_pos, event_json) VALUES (?, ?, ?, ?)",
			),
			getEvent: this.db.prepare(
				"SELECT event_id, event_json FROM events WHERE event_id = ?",
			),
			insertTimelineEntry: this.db.prepare(
				"INSERT OR REPLACE INTO events (event_id, room_id, stream_pos, event_json) VALUES (?, ?, ?, ?)",
			),
			getSession: this.db.prepare(
				"SELECT * FROM sessions WHERE access_token = ?",
			),
			insertSession: this.db.prepare(
				"INSERT OR REPLACE INTO sessions (access_token, refresh_token, device_id, user_id, access_token_hash, expires_at, display_name, last_seen_ip, last_seen_ts, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			),
			insertStateEvent: this.db.prepare(
				"INSERT OR REPLACE INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES (?, ?, ?, ?, ?)",
			),
			getStateEvent: this.db.prepare(
				"SELECT event_id, event_json FROM state_events WHERE room_id = ? AND event_type = ? AND state_key = ?",
			),
			getTxn: this.db.prepare(
				"SELECT event_id FROM txn_map WHERE user_id = ? AND device_id = ? AND txn_id = ?",
			),
			setTxn: this.db.prepare(
				"INSERT OR REPLACE INTO txn_map (user_id, device_id, txn_id, event_id) VALUES (?, ?, ?, ?)",
			),
		};
	}

	async createUser(account: UserAccount): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO users (user_id, localpart, server_name, password_hash, account_type, is_deactivated, created_at, displayname, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				account.user_id,
				account.localpart,
				account.server_name,
				account.password_hash,
				account.account_type,
				account.is_deactivated ? 1 : 0,
				account.created_at,
				account.displayname ?? null,
				account.avatar_url ?? null,
			);
	}

	async getUserByLocalpart(
		localpart: string,
	): Promise<UserAccount | undefined> {
		const row = this.db
			.prepare("SELECT * FROM users WHERE localpart = ?")
			.get(localpart) as Record<string, unknown> | undefined;
		return row ? rowToUser(row, true) : undefined;
	}

	async getUserById(userId: UserId): Promise<UserAccount | undefined> {
		const row = this.db
			.prepare("SELECT * FROM users WHERE user_id = ?")
			.get(userId) as Record<string, unknown> | undefined;
		return row ? rowToUser(row, true) : undefined;
	}

	async createSession(session: StoredSession): Promise<void> {
		this.stmts.insertSession.run(
			session.access_token,
			session.refresh_token ?? null,
			session.device_id,
			session.user_id,
			session.access_token_hash,
			session.expires_at ?? null,
			session.display_name ?? null,
			session.last_seen_ip ?? null,
			session.last_seen_ts ?? null,
			session.user_agent ?? null,
		);
	}

	async getSessionByAccessToken(
		token: AccessToken,
	): Promise<StoredSession | undefined> {
		const row = this.stmts.getSession.get(token) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToSession(row) : undefined;
	}

	async getSessionByRefreshToken(
		token: RefreshToken,
	): Promise<StoredSession | undefined> {
		const row = this.db
			.prepare("SELECT * FROM sessions WHERE refresh_token = ?")
			.get(token) as Record<string, unknown> | undefined;
		return row ? rowToSession(row) : undefined;
	}

	async getSessionsByUser(userId: UserId): Promise<StoredSession[]> {
		const rows = this.db
			.prepare("SELECT * FROM sessions WHERE user_id = ?")
			.all(userId) as Record<string, unknown>[];
		return rows.map((r) => rowToSession(r));
	}

	async deleteSession(token: AccessToken): Promise<void> {
		this.db.prepare("DELETE FROM sessions WHERE access_token = ?").run(token);
	}

	async deleteAllSessions(userId: UserId): Promise<void> {
		this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
	}

	async rotateToken(
		oldAccessToken: AccessToken,
		newAccessToken: AccessToken,
		newRefreshToken?: RefreshToken,
		expiresAt?: Timestamp,
	): Promise<StoredSession | undefined> {
		const session = await this.getSessionByAccessToken(oldAccessToken);
		if (!session) return undefined;

		await this.deleteSession(oldAccessToken);

		const updated: StoredSession = {
			...session,
			access_token: newAccessToken,
			refresh_token: newRefreshToken,
			expires_at: expiresAt,
		};

		await this.createSession(updated);
		return updated;
	}

	async touchSession(
		token: AccessToken,
		ip: string,
		userAgent: string,
	): Promise<void> {
		this.db
			.prepare(
				"UPDATE sessions SET last_seen_ip = ?, last_seen_ts = ?, user_agent = ? WHERE access_token = ?",
			)
			.run(ip, Date.now(), userAgent, token);
	}

	async createUIAASession(sessionId: string): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO uiaa_sessions (session_id, completed) VALUES (?, '[]')",
			)
			.run(sessionId);
	}

	async getUIAASession(
		sessionId: string,
	): Promise<{ completed: string[] } | undefined> {
		const row = this.db
			.prepare("SELECT completed FROM uiaa_sessions WHERE session_id = ?")
			.get(sessionId) as { completed: string } | undefined;
		if (!row) return undefined;
		return { completed: JSON.parse(row.completed) };
	}

	async addUIAACompleted(sessionId: string, stageType: string): Promise<void> {
		const session = await this.getUIAASession(sessionId);
		if (!session) return;
		session.completed.push(stageType);
		this.db
			.prepare("UPDATE uiaa_sessions SET completed = ? WHERE session_id = ?")
			.run(JSON.stringify(session.completed), sessionId);
	}

	async deleteUIAASession(sessionId: string): Promise<void> {
		this.db
			.prepare("DELETE FROM uiaa_sessions WHERE session_id = ?")
			.run(sessionId);
	}

	async createRoom(state: RoomState): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO rooms (room_id, room_version, depth, forward_extremities) VALUES (?, ?, ?, ?)",
			)
			.run(
				state.room_id,
				state.room_version,
				state.depth,
				JSON.stringify(state.forward_extremities),
			);

		for (const [key, event] of state.state_events) {
			const [eventType, stateKey] = key.split("\0") as [string, string];
			const eventId = computeEventId(event);
			this.stmts.insertStateEvent.run(
				state.room_id,
				eventType,
				stateKey,
				eventId,
				JSON.stringify(event),
			);
		}

		// Cache the reference so setStateEvent can mutate it in-place
		this.roomCache.set(state.room_id, state);
	}

	async getRoom(roomId: RoomId): Promise<RoomState | undefined> {
		// Return cached reference if available (needed for in-place mutation)
		const cached = this.roomCache.get(roomId);
		if (cached) return cached;

		const row = this.db
			.prepare("SELECT * FROM rooms WHERE room_id = ?")
			.get(roomId) as Record<string, unknown> | undefined;
		if (!row) return undefined;

		const stateRows = this.db
			.prepare("SELECT * FROM state_events WHERE room_id = ?")
			.all(roomId) as {
			event_type: string;
			state_key: string;
			event_json: string;
		}[];

		const stateMap = new Map<string, PDU>();
		for (const sr of stateRows) {
			stateMap.set(
				`${sr.event_type}\0${sr.state_key}`,
				JSON.parse(sr.event_json),
			);
		}

		const room: RoomState = {
			room_id: row.room_id as RoomId,
			room_version: row.room_version as RoomVersion,
			state_events: stateMap,
			depth: row.depth as number,
			forward_extremities: JSON.parse(row.forward_extremities as string),
		};

		this.roomCache.set(roomId, room);
		return room;
	}

	async getRoomsForUser(userId: UserId): Promise<RoomId[]> {
		const rows = this.db
			.prepare(
				"SELECT room_id FROM state_events WHERE event_type = 'm.room.member' AND state_key = ? AND json_extract(event_json, '$.content.membership') = 'join'",
			)
			.all(userId) as { room_id: string }[];
		return rows.map((r) => r.room_id as RoomId);
	}

	async storeEvent(event: PDU, eventId: EventId): Promise<void> {
		this.streamCounter++;
		this.stmts.insertEvent.run(
			eventId,
			event.room_id,
			this.streamCounter,
			JSON.stringify(event),
		);
		this.wakeWaiters();
	}

	async getEvent(
		eventId: EventId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const row = this.stmts.getEvent.get(eventId) as
			| { event_id: string; event_json: string }
			| undefined;
		if (!row) return undefined;
		return {
			event: JSON.parse(row.event_json),
			eventId: row.event_id as EventId,
		};
	}

	async getEventsByRoom(
		roomId: RoomId,
		limit: number,
		from?: number,
		direction: "b" | "f" = "f",
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		end?: number;
	}> {
		const fromPos = from ?? (direction === "f" ? 0 : this.streamCounter + 1);

		let rows: { event_id: string; event_json: string; stream_pos: number }[];
		if (direction === "f") {
			rows = this.db
				.prepare(
					"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos ASC LIMIT ?",
				)
				.all(roomId, fromPos, limit) as typeof rows;
		} else {
			rows = this.db
				.prepare(
					"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos < ? ORDER BY stream_pos DESC LIMIT ?",
				)
				.all(roomId, fromPos, limit) as typeof rows;
		}

		const events = rows.map((r) => ({
			event: JSON.parse(r.event_json) as PDU,
			eventId: r.event_id as EventId,
		}));

		const lastRow = rows[rows.length - 1];
		const end = lastRow ? lastRow.stream_pos : undefined;
		return { events, end };
	}

	async getStreamPosition(): Promise<number> {
		return this.streamCounter;
	}

	async getStateEvent(
		roomId: RoomId,
		eventType: string,
		stateKey: string,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const row = this.stmts.getStateEvent.get(roomId, eventType, stateKey) as
			| { event_id: string; event_json: string }
			| undefined;
		if (!row) return undefined;
		return {
			event: JSON.parse(row.event_json),
			eventId: row.event_id as EventId,
		};
	}

	async getAllState(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const rows = this.db
			.prepare(
				"SELECT event_id, event_json FROM state_events WHERE room_id = ?",
			)
			.all(roomId) as { event_id: string; event_json: string }[];
		return rows.map((r) => ({
			event: JSON.parse(r.event_json),
			eventId: r.event_id as EventId,
		}));
	}

	async setStateEvent(
		roomId: RoomId,
		event: PDU,
		eventId: EventId,
	): Promise<void> {
		this.stmts.insertStateEvent.run(
			roomId,
			event.type,
			event.state_key ?? "",
			eventId,
			JSON.stringify(event),
		);

		// Update cached room state in-place (handler relies on reference sharing)
		const cached = this.roomCache.get(roomId);
		if (cached) {
			const key = `${event.type}\0${event.state_key ?? ""}`;
			cached.state_events.set(key, event);
		}

		await this.storeEvent(event, eventId);
	}

	async getMemberEvents(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const rows = this.db
			.prepare(
				"SELECT event_id, event_json FROM state_events WHERE room_id = ? AND event_type = 'm.room.member'",
			)
			.all(roomId) as { event_id: string; event_json: string }[];
		return rows.map((r) => ({
			event: JSON.parse(r.event_json),
			eventId: r.event_id as EventId,
		}));
	}

	async getTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
	): Promise<EventId | undefined> {
		const row = this.stmts.getTxn.get(userId, deviceId, txnId) as
			| { event_id: string }
			| undefined;
		return row ? (row.event_id as EventId) : undefined;
	}

	async setTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
		eventId: EventId,
	): Promise<void> {
		this.stmts.setTxn.run(userId, deviceId, txnId, eventId);
	}

	async getRoomsForUserWithMembership(
		userId: UserId,
	): Promise<{ roomId: RoomId; membership: string }[]> {
		const rows = this.db
			.prepare(
				"SELECT room_id, json_extract(event_json, '$.content.membership') as membership FROM state_events WHERE event_type = 'm.room.member' AND state_key = ?",
			)
			.all(userId) as { room_id: string; membership: string }[];
		return rows
			.filter((r) => r.membership)
			.map((r) => ({ roomId: r.room_id as RoomId, membership: r.membership }));
	}

	async getEventsByRoomSince(
		roomId: RoomId,
		since: number,
		limit: number,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		limited: boolean;
	}> {
		const countRow = this.db
			.prepare(
				"SELECT COUNT(*) as cnt FROM events WHERE room_id = ? AND stream_pos > ?",
			)
			.get(roomId, since) as { cnt: number };
		const total = countRow.cnt;
		const limited = total > limit;

		// When limited, take the most recent events (tail)
		let rows: { event_id: string; event_json: string; stream_pos: number }[];
		if (limited) {
			rows = this.db
				.prepare(
					"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos DESC LIMIT ?",
				)
				.all(roomId, since, limit) as typeof rows;
			rows.reverse();
		} else {
			rows = this.db
				.prepare(
					"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos ASC",
				)
				.all(roomId, since) as typeof rows;
		}

		const events = rows.map((r) => ({
			event: JSON.parse(r.event_json) as PDU,
			eventId: r.event_id as EventId,
			streamPos: r.stream_pos,
		}));

		return { events, limited };
	}

	async getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]> {
		const placeholders = INVITE_STATE_TYPES.map(() => "?").join(",");
		const rows = this.db
			.prepare(
				`SELECT event_json FROM state_events WHERE room_id = ? AND event_type IN (${placeholders})`,
			)
			.all(roomId, ...INVITE_STATE_TYPES) as { event_json: string }[];

		return rows.map((r) => {
			const event = JSON.parse(r.event_json) as PDU;
			return eventToStrippedState(event);
		});
	}

	async getProfile(userId: UserId): Promise<UserProfile | undefined> {
		const row = this.db
			.prepare("SELECT displayname, avatar_url FROM users WHERE user_id = ?")
			.get(userId) as
			| { displayname: string | null; avatar_url: string | null }
			| undefined;
		if (!row) return undefined;
		const profile: UserProfile = {};
		if (row.displayname) profile.displayname = row.displayname;
		if (row.avatar_url) profile.avatar_url = row.avatar_url;
		return profile;
	}

	async setDisplayName(
		userId: UserId,
		displayname: string | null,
	): Promise<void> {
		this.db
			.prepare("UPDATE users SET displayname = ? WHERE user_id = ?")
			.run(displayname, userId);
	}

	async setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void> {
		this.db
			.prepare("UPDATE users SET avatar_url = ? WHERE user_id = ?")
			.run(avatarUrl, userId);
	}

	async getDevice(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Device | undefined> {
		const row = this.db
			.prepare(
				"SELECT device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = ? AND device_id = ? LIMIT 1",
			)
			.get(userId, deviceId) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return {
			device_id: row.device_id as DeviceId,
			display_name: (row.display_name as string) ?? undefined,
			last_seen_ip: (row.last_seen_ip as string) ?? undefined,
			last_seen_ts: (row.last_seen_ts as number) ?? undefined,
		};
	}

	async getAllDevices(userId: UserId): Promise<Device[]> {
		const rows = this.db
			.prepare(
				"SELECT DISTINCT device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = ?",
			)
			.all(userId) as Record<string, unknown>[];
		return rows.map((r) => ({
			device_id: r.device_id as DeviceId,
			display_name: (r.display_name as string) ?? undefined,
			last_seen_ip: (r.last_seen_ip as string) ?? undefined,
			last_seen_ts: (r.last_seen_ts as number) ?? undefined,
		}));
	}

	async updateDeviceDisplayName(
		userId: UserId,
		deviceId: DeviceId,
		displayName: string,
	): Promise<void> {
		this.db
			.prepare(
				"UPDATE sessions SET display_name = ? WHERE user_id = ? AND device_id = ?",
			)
			.run(displayName, userId, deviceId);
	}

	async deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void> {
		this.db
			.prepare("DELETE FROM sessions WHERE user_id = ? AND device_id = ?")
			.run(userId, deviceId);
	}

	async updatePassword(userId: UserId, newPasswordHash: string): Promise<void> {
		this.db
			.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?")
			.run(newPasswordHash, userId);
	}

	async deactivateUser(userId: UserId): Promise<void> {
		this.db
			.prepare("UPDATE users SET is_deactivated = 1 WHERE user_id = ?")
			.run(userId);
		await this.deleteAllSessions(userId);
	}

	async createRoomAlias(
		roomAlias: RoomAlias,
		roomId: RoomId,
		servers: ServerName[],
		creator: UserId,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO room_aliases (room_alias, room_id, servers, creator) VALUES (?, ?, ?, ?)",
			)
			.run(roomAlias, roomId, JSON.stringify(servers), creator);
	}

	async deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean> {
		const result = this.db
			.prepare("DELETE FROM room_aliases WHERE room_alias = ?")
			.run(roomAlias);
		return result.changes > 0;
	}

	async getRoomByAlias(
		roomAlias: RoomAlias,
	): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined> {
		const row = this.db
			.prepare("SELECT room_id, servers FROM room_aliases WHERE room_alias = ?")
			.get(roomAlias) as { room_id: string; servers: string } | undefined;
		if (!row) return undefined;
		return {
			room_id: row.room_id as RoomId,
			servers: JSON.parse(row.servers),
		};
	}

	async getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]> {
		const rows = this.db
			.prepare("SELECT room_alias FROM room_aliases WHERE room_id = ?")
			.all(roomId) as { room_alias: string }[];
		return rows.map((r) => r.room_alias as RoomAlias);
	}

	async getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined> {
		const row = this.db
			.prepare("SELECT creator FROM room_aliases WHERE room_alias = ?")
			.get(roomAlias) as { creator: string } | undefined;
		return row ? (row.creator as UserId) : undefined;
	}

	async setRoomVisibility(
		roomId: RoomId,
		visibility: "public" | "private",
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO room_directory (room_id, visibility) VALUES (?, ?)",
			)
			.run(roomId, visibility);
	}

	async getRoomVisibility(roomId: RoomId): Promise<"public" | "private"> {
		const row = this.db
			.prepare("SELECT visibility FROM room_directory WHERE room_id = ?")
			.get(roomId) as { visibility: string } | undefined;
		return (row?.visibility as "public" | "private") ?? "private";
	}

	async getPublicRoomIds(): Promise<RoomId[]> {
		const rows = this.db
			.prepare("SELECT room_id FROM room_directory WHERE visibility = 'public'")
			.all() as { room_id: string }[];
		return rows.map((r) => r.room_id as RoomId);
	}

	async getGlobalAccountData(
		userId: UserId,
		type: string,
	): Promise<JsonObject | undefined> {
		const row = this.db
			.prepare(
				"SELECT content FROM global_account_data WHERE user_id = ? AND type = ?",
			)
			.get(userId, type) as { content: string } | undefined;
		return row ? JSON.parse(row.content) : undefined;
	}

	async setGlobalAccountData(
		userId: UserId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO global_account_data (user_id, type, content) VALUES (?, ?, ?)",
			)
			.run(userId, type, JSON.stringify(content));
	}

	async getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const rows = this.db
			.prepare(
				"SELECT type, content FROM global_account_data WHERE user_id = ?",
			)
			.all(userId) as { type: string; content: string }[];
		return rows.map((r) => ({ type: r.type, content: JSON.parse(r.content) }));
	}

	async getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined> {
		const row = this.db
			.prepare(
				"SELECT content FROM room_account_data WHERE user_id = ? AND room_id = ? AND type = ?",
			)
			.get(userId, roomId, type) as { content: string } | undefined;
		return row ? JSON.parse(row.content) : undefined;
	}

	async setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO room_account_data (user_id, room_id, type, content) VALUES (?, ?, ?, ?)",
			)
			.run(userId, roomId, type, JSON.stringify(content));
	}

	async getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const rows = this.db
			.prepare(
				"SELECT type, content FROM room_account_data WHERE user_id = ? AND room_id = ?",
			)
			.all(userId, roomId) as { type: string; content: string }[];
		return rows.map((r) => ({ type: r.type, content: JSON.parse(r.content) }));
	}

	async setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO receipts (room_id, user_id, event_id, receipt_type, ts) VALUES (?, ?, ?, ?, ?)",
			)
			.run(roomId, userId, eventId, receiptType, ts);
		this.wakeWaiters();
	}

	async getReceipts(
		roomId: RoomId,
	): Promise<
		{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]
	> {
		const rows = this.db
			.prepare("SELECT * FROM receipts WHERE room_id = ?")
			.all(roomId) as {
			event_id: string;
			receipt_type: string;
			user_id: string;
			ts: number;
		}[];
		return rows.map((r) => ({
			eventId: r.event_id as EventId,
			receiptType: r.receipt_type,
			userId: r.user_id as UserId,
			ts: r.ts,
		}));
	}

	async storeMedia(media: StoredMedia, data: Buffer): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO media (origin, media_id, user_id, content_type, upload_name, file_size, content_hash, created_at, quarantined, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				media.origin,
				media.media_id,
				media.user_id ?? null,
				media.content_type,
				media.upload_name ?? null,
				media.file_size,
				media.content_hash,
				media.created_at,
				media.quarantined ? 1 : 0,
				data,
			);
	}

	async getMedia(
		serverName: ServerName,
		mediaId: string,
	): Promise<{ metadata: StoredMedia; data: Buffer } | undefined> {
		const row = this.db
			.prepare("SELECT * FROM media WHERE origin = ? AND media_id = ?")
			.get(serverName, mediaId) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return {
			metadata: {
				media_id: row.media_id as string,
				origin: row.origin as ServerName,
				user_id: (row.user_id as UserId) ?? undefined,
				content_type: row.content_type as string,
				upload_name: (row.upload_name as string) ?? undefined,
				file_size: row.file_size as number,
				content_hash: row.content_hash as string,
				created_at: row.created_at as number,
				quarantined: row.quarantined === 1,
			},
			data: row.data as Buffer,
		};
	}

	async createFilter(userId: UserId, filter: JsonObject): Promise<string> {
		const filterId = String(++this.filterCounter);
		this.db
			.prepare(
				"INSERT OR REPLACE INTO filters (user_id, filter_id, filter_json) VALUES (?, ?, ?)",
			)
			.run(userId, filterId, JSON.stringify(filter));
		return filterId;
	}

	async getFilter(
		userId: UserId,
		filterId: string,
	): Promise<JsonObject | undefined> {
		const row = this.db
			.prepare(
				"SELECT filter_json FROM filters WHERE user_id = ? AND filter_id = ?",
			)
			.get(userId, filterId) as { filter_json: string } | undefined;
		return row ? JSON.parse(row.filter_json) : undefined;
	}

	async setDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: DeviceKeys,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO device_keys (user_id, device_id, keys_json) VALUES (?, ?, ?)",
			)
			.run(userId, deviceId, JSON.stringify(keys));
	}

	async getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined> {
		const row = this.db
			.prepare(
				"SELECT keys_json FROM device_keys WHERE user_id = ? AND device_id = ?",
			)
			.get(userId, deviceId) as { keys_json: string } | undefined;
		return row ? JSON.parse(row.keys_json) : undefined;
	}

	async getAllDeviceKeys(
		userId: UserId,
	): Promise<Record<DeviceId, DeviceKeys>> {
		const rows = this.db
			.prepare("SELECT device_id, keys_json FROM device_keys WHERE user_id = ?")
			.all(userId) as { device_id: string; keys_json: string }[];
		const result: Record<DeviceId, DeviceKeys> = {};
		for (const r of rows) {
			result[r.device_id as DeviceId] = JSON.parse(r.keys_json);
		}
		return result;
	}

	async addOneTimeKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const stmt = this.db.prepare(
			"INSERT OR REPLACE INTO one_time_keys (user_id, device_id, key_id, algorithm, key_json) VALUES (?, ?, ?, ?, ?)",
		);
		const insertAll = this.db.transaction(() => {
			for (const [keyId, key] of Object.entries(keys)) {
				const algorithm = keyId.split(":")[0] as string;
				stmt.run(userId, deviceId, keyId, algorithm, JSON.stringify(key));
			}
		});
		insertAll();
	}

	async claimOneTimeKey(
		userId: UserId,
		deviceId: DeviceId,
		algorithm: string,
	): Promise<{ keyId: KeyId; key: string | OneTimeKey } | undefined> {
		const row = this.db
			.prepare(
				"SELECT key_id, key_json FROM one_time_keys WHERE user_id = ? AND device_id = ? AND algorithm = ? LIMIT 1",
			)
			.get(userId, deviceId, algorithm) as
			| { key_id: string; key_json: string }
			| undefined;

		if (row) {
			this.db
				.prepare(
					"DELETE FROM one_time_keys WHERE user_id = ? AND device_id = ? AND key_id = ?",
				)
				.run(userId, deviceId, row.key_id);
			return { keyId: row.key_id as KeyId, key: JSON.parse(row.key_json) };
		}

		// Fall back to fallback keys
		const fallback = this.db
			.prepare(
				"SELECT key_id, key_json FROM fallback_keys WHERE user_id = ? AND device_id = ? AND key_id LIKE ? LIMIT 1",
			)
			.get(userId, deviceId, `${algorithm}:%`) as
			| { key_id: string; key_json: string }
			| undefined;

		if (fallback) {
			return {
				keyId: fallback.key_id as KeyId,
				key: JSON.parse(fallback.key_json),
			};
		}

		return undefined;
	}

	async getOneTimeKeyCounts(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Record<string, number>> {
		const rows = this.db
			.prepare(
				"SELECT algorithm, COUNT(*) as cnt FROM one_time_keys WHERE user_id = ? AND device_id = ? GROUP BY algorithm",
			)
			.all(userId, deviceId) as { algorithm: string; cnt: number }[];
		const counts: Record<string, number> = {};
		for (const r of rows) {
			counts[r.algorithm] = r.cnt;
		}
		return counts;
	}

	async setFallbackKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const del = this.db.prepare(
			"DELETE FROM fallback_keys WHERE user_id = ? AND device_id = ?",
		);
		const ins = this.db.prepare(
			"INSERT INTO fallback_keys (user_id, device_id, key_id, key_json) VALUES (?, ?, ?, ?)",
		);
		this.db.transaction(() => {
			del.run(userId, deviceId);
			for (const [keyId, key] of Object.entries(keys)) {
				ins.run(userId, deviceId, keyId, JSON.stringify(key));
			}
		})();
	}

	async getFallbackKeyTypes(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<string[]> {
		const rows = this.db
			.prepare(
				"SELECT DISTINCT key_id FROM fallback_keys WHERE user_id = ? AND device_id = ?",
			)
			.all(userId, deviceId) as { key_id: string }[];
		const types = new Set<string>();
		for (const r of rows) {
			types.add(r.key_id.split(":")[0] as string);
		}
		return [...types];
	}

	async sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT INTO to_device (user_id, device_id, event_json) VALUES (?, ?, ?)",
			)
			.run(userId, deviceId, JSON.stringify(event));
		this.wakeWaiters();
	}

	async getToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<ToDeviceEvent[]> {
		const rows = this.db
			.prepare(
				"SELECT event_json FROM to_device WHERE user_id = ? AND device_id = ? ORDER BY id",
			)
			.all(userId, deviceId) as { event_json: string }[];
		return rows.map((r) => JSON.parse(r.event_json));
	}

	async clearToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<void> {
		this.db
			.prepare("DELETE FROM to_device WHERE user_id = ? AND device_id = ?")
			.run(userId, deviceId);
	}

	async getPushers(userId: UserId): Promise<Pusher[]> {
		const rows = this.db
			.prepare("SELECT pusher_json FROM pushers WHERE user_id = ?")
			.all(userId) as { pusher_json: string }[];
		return rows.map((r) => JSON.parse(r.pusher_json));
	}

	async setPusher(userId: UserId, pusher: Pusher): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO pushers (user_id, app_id, pushkey, pusher_json) VALUES (?, ?, ?, ?)",
			)
			.run(userId, pusher.app_id, pusher.pushkey, JSON.stringify(pusher));
	}

	async deletePusher(
		userId: UserId,
		appId: string,
		pushkey: string,
	): Promise<void> {
		this.db
			.prepare(
				"DELETE FROM pushers WHERE user_id = ? AND app_id = ? AND pushkey = ?",
			)
			.run(userId, appId, pushkey);
	}

	async deletePusherByKey(appId: string, pushkey: string): Promise<void> {
		this.db
			.prepare("DELETE FROM pushers WHERE app_id = ? AND pushkey = ?")
			.run(appId, pushkey);
	}

	async storeRelation(
		eventId: EventId,
		roomId: RoomId,
		relType: string,
		targetEventId: EventId,
		key?: string,
	): Promise<void> {
		const eventRow = this.stmts.getEvent.get(eventId) as
			| { event_json: string }
			| undefined;
		if (!eventRow) return;
		const event = JSON.parse(eventRow.event_json) as PDU;

		const posRow = this.db
			.prepare("SELECT stream_pos FROM events WHERE event_id = ?")
			.get(eventId) as { stream_pos: number } | undefined;
		const streamPos = posRow?.stream_pos ?? this.streamCounter;

		this.db
			.prepare(
				"INSERT INTO relations (event_id, room_id, rel_type, target_event_id, key, sender, event_type, stream_pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				eventId,
				roomId,
				relType,
				targetEventId,
				key ?? null,
				event.sender,
				event.type,
				streamPos,
			);
	}

	async getRelatedEvents(
		roomId: RoomId,
		eventId: EventId,
		relType?: string,
		eventType?: string,
		limit = 50,
		from?: string,
		direction: "b" | "f" = "f",
	): Promise<{
		events: { event: PDU; eventId: EventId }[];
		nextBatch?: string;
	}> {
		let sql =
			"SELECT r.event_id, r.stream_pos, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = ? AND r.room_id = ?";
		const params: unknown[] = [eventId, roomId];

		if (relType) {
			sql += " AND r.rel_type = ?";
			params.push(relType);
		}
		if (eventType) {
			sql += " AND r.event_type = ?";
			params.push(eventType);
		}

		const fromPos = from ? parseInt(from, 10) : undefined;
		if (fromPos !== undefined) {
			if (direction === "f") {
				sql += " AND r.stream_pos > ?";
			} else {
				sql += " AND r.stream_pos < ?";
			}
			params.push(fromPos);
		}

		sql +=
			direction === "f"
				? " ORDER BY r.stream_pos ASC LIMIT ?"
				: " ORDER BY r.stream_pos DESC LIMIT ?";
		params.push(limit);

		const rows = this.db.prepare(sql).all(...params) as {
			event_id: string;
			stream_pos: number;
			event_json: string;
		}[];

		const events = rows.map((r) => ({
			event: JSON.parse(r.event_json) as PDU,
			eventId: r.event_id as EventId,
		}));

		const nextBatch =
			rows.length === limit && rows.length > 0
				? String(rows[rows.length - 1]?.stream_pos)
				: undefined;

		return { events, nextBatch };
	}

	async getAnnotationCounts(
		eventId: EventId,
	): Promise<{ type: string; key: string; count: number }[]> {
		const rows = this.db
			.prepare(
				"SELECT event_type, key, COUNT(*) as cnt FROM relations WHERE target_event_id = ? AND rel_type = 'm.annotation' AND key IS NOT NULL GROUP BY event_type, key",
			)
			.all(eventId) as { event_type: string; key: string; cnt: number }[];
		return rows.map((r) => ({ type: r.event_type, key: r.key, count: r.cnt }));
	}

	async getLatestEdit(
		eventId: EventId,
		sender: UserId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const row = this.db
			.prepare(
				"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = ? AND r.rel_type = 'm.replace' AND r.sender = ? ORDER BY r.stream_pos DESC LIMIT 1",
			)
			.get(eventId, sender) as
			| { event_id: string; event_json: string }
			| undefined;
		if (!row) return undefined;
		return {
			event: JSON.parse(row.event_json),
			eventId: row.event_id as EventId,
		};
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
		const countRow = this.db
			.prepare(
				"SELECT COUNT(*) as cnt FROM relations WHERE target_event_id = ? AND rel_type = 'm.thread'",
			)
			.get(eventId) as { cnt: number };
		if (countRow.cnt === 0) return undefined;

		const latestRow = this.db
			.prepare(
				"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = ? AND r.rel_type = 'm.thread' ORDER BY r.stream_pos DESC LIMIT 1",
			)
			.get(eventId) as { event_id: string; event_json: string } | undefined;
		if (!latestRow) return undefined;

		const participatedRow = this.db
			.prepare(
				"SELECT 1 FROM relations WHERE target_event_id = ? AND rel_type = 'm.thread' AND sender = ? LIMIT 1",
			)
			.get(eventId, userId) as unknown | undefined;

		return {
			latestEvent: {
				event: JSON.parse(latestRow.event_json),
				eventId: latestRow.event_id as EventId,
			},
			count: countRow.cnt,
			currentUserParticipated: !!participatedRow,
		};
	}

	async storeReport(
		userId: UserId,
		roomId: RoomId,
		eventId: EventId,
		score?: number,
		reason?: string,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT INTO reports (user_id, room_id, event_id, score, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(userId, roomId, eventId, score ?? null, reason ?? null, Date.now());
	}

	async storeOpenIdToken(
		token: string,
		userId: UserId,
		expiresAt: Timestamp,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO openid_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
			)
			.run(token, userId, expiresAt);
	}

	async getOpenIdToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: Timestamp } | undefined> {
		const row = this.db
			.prepare("SELECT user_id, expires_at FROM openid_tokens WHERE token = ?")
			.get(token) as { user_id: string; expires_at: number } | undefined;
		if (!row) return undefined;
		return { userId: row.user_id as UserId, expiresAt: row.expires_at };
	}

	async getThreePids(
		userId: UserId,
	): Promise<{ medium: string; address: string; added_at: Timestamp }[]> {
		return this.db
			.prepare(
				"SELECT medium, address, added_at FROM threepids WHERE user_id = ?",
			)
			.all(userId) as { medium: string; address: string; added_at: number }[];
	}

	async addThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO threepids (user_id, medium, address, added_at) VALUES (?, ?, ?, ?)",
			)
			.run(userId, medium, address, Date.now());
	}

	async deleteThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		this.db
			.prepare(
				"DELETE FROM threepids WHERE user_id = ? AND medium = ? AND address = ?",
			)
			.run(userId, medium, address);
	}

	async searchUserDirectory(
		searchTerm: string,
		limit: number,
	): Promise<
		{ user_id: UserId; display_name?: string; avatar_url?: string }[]
	> {
		const term = `%${searchTerm}%`;
		const rows = this.db
			.prepare(
				"SELECT user_id, displayname, avatar_url FROM users WHERE is_deactivated = 0 AND (user_id LIKE ? OR displayname LIKE ?) LIMIT ?",
			)
			.all(term, term, limit) as {
			user_id: string;
			displayname: string | null;
			avatar_url: string | null;
		}[];
		return rows.map((r) => ({
			user_id: r.user_id as UserId,
			display_name: r.displayname ?? undefined,
			avatar_url: r.avatar_url ?? undefined,
		}));
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
		let sql = `
			SELECT r.target_event_id, MAX(r.stream_pos) as latest_pos, e.event_json
			FROM relations r
			JOIN events e ON r.target_event_id = e.event_id
			WHERE r.rel_type = 'm.thread' AND r.room_id = ?
		`;
		const params: unknown[] = [roomId];

		if (include === "participated") {
			sql +=
				" AND r.target_event_id IN (SELECT target_event_id FROM relations WHERE rel_type = 'm.thread' AND sender = ?)";
			params.push(userId);
		}

		if (from) {
			sql += " AND r.stream_pos < ?";
			params.push(parseInt(from, 10));
		}

		sql += " GROUP BY r.target_event_id ORDER BY latest_pos DESC LIMIT ?";
		params.push(limit);

		const rows = this.db.prepare(sql).all(...params) as {
			target_event_id: string;
			latest_pos: number;
			event_json: string;
		}[];

		const events = rows.map((r) => ({
			event: JSON.parse(r.event_json) as PDU,
			eventId: r.target_event_id as EventId,
		}));

		const nextBatch =
			rows.length === limit && rows.length > 0
				? String(rows[rows.length - 1]?.latest_pos)
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
		if (roomIds.length === 0) return { events: [] };

		const placeholders = roomIds.map(() => "?").join(",");
		let sql = `SELECT event_id, event_json, stream_pos FROM events WHERE room_id IN (${placeholders})`;
		const params: unknown[] = [...roomIds];

		if (from) {
			sql += " AND stream_pos < ?";
			params.push(parseInt(from, 10));
		}

		sql += " ORDER BY stream_pos DESC";

		const rows = this.db.prepare(sql).all(...params) as {
			event_id: string;
			event_json: string;
			stream_pos: number;
		}[];

		const term = searchTerm.toLowerCase();
		const results: { event: PDU; eventId: EventId; streamPos: number }[] = [];

		for (const row of rows) {
			if (results.length >= limit) break;
			const event = JSON.parse(row.event_json) as PDU;
			const content = event.content as Record<string, unknown>;
			let matched = false;
			for (const key of keys) {
				const field =
					key === "content.body"
						? content.body
						: key === "content.name"
							? content.name
							: key === "content.topic"
								? content.topic
								: undefined;
				if (typeof field === "string" && field.toLowerCase().includes(term)) {
					matched = true;
					break;
				}
			}
			if (matched) {
				results.push({
					event,
					eventId: row.event_id as EventId,
					streamPos: row.stream_pos,
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
		const stmt = this.db.prepare(
			"INSERT OR REPLACE INTO server_keys (server_name, key_id, key, valid_until) VALUES (?, ?, ?, ?)",
		);
		this.db.transaction(() => {
			for (const [keyId, val] of Object.entries(keys.verify_keys)) {
				stmt.run(serverName, keyId, val.key, keys.valid_until_ts);
			}
		})();
	}

	async getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined> {
		const row = this.db
			.prepare(
				"SELECT key, valid_until FROM server_keys WHERE server_name = ? AND key_id = ?",
			)
			.get(serverName, keyId) as
			| { key: string; valid_until: number }
			| undefined;
		if (!row) return undefined;
		return { key: row.key, validUntil: row.valid_until };
	}

	async getAuthChain(eventIds: EventId[]): Promise<PDU[]> {
		const visited = new Set<EventId>();
		const result: PDU[] = [];
		const queue = [...eventIds];

		while (queue.length > 0) {
			const id = queue.shift() as EventId;
			if (visited.has(id)) continue;
			visited.add(id);

			const row = this.stmts.getEvent.get(id) as
				| { event_json: string }
				| undefined;
			if (!row) continue;
			const event = JSON.parse(row.event_json) as PDU;
			result.push(event);

			for (const authId of event.auth_events) {
				if (!visited.has(authId)) queue.push(authId);
			}
		}

		return result;
	}

	async getServersInRoom(roomId: RoomId): Promise<ServerName[]> {
		const rows = this.db
			.prepare(
				"SELECT state_key FROM state_events WHERE room_id = ? AND event_type = 'm.room.member' AND json_extract(event_json, '$.content.membership') = 'join'",
			)
			.all(roomId) as { state_key: string }[];

		const servers = new Set<ServerName>();
		for (const r of rows) {
			const serverName = r.state_key
				.split(":")
				.slice(1)
				.join(":") as ServerName;
			servers.add(serverName);
		}
		return [...servers];
	}

	async getStateAtEvent(
		_roomId: RoomId,
		_eventId: EventId,
	): Promise<Map<string, PDU> | undefined> {
		// Simplified: return current room state
		const room = await this.getRoom(_roomId);
		if (!room) return undefined;
		return new Map(room.state_events);
	}

	async getFederationTxn(origin: ServerName, txnId: string): Promise<boolean> {
		const row = this.db
			.prepare("SELECT 1 FROM federation_txns WHERE origin = ? AND txn_id = ?")
			.get(origin, txnId);
		return !!row;
	}

	async setFederationTxn(origin: ServerName, txnId: string): Promise<void> {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO federation_txns (origin, txn_id) VALUES (?, ?)",
			)
			.run(origin, txnId);
	}

	// 3PID verification — in-memory for simplicity (not persisted across restarts)
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

	async getVerificationSession(
		sessionId: string,
	): Promise<
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
		this.db.transaction(() => {
			for (const event of authChain) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				this.stmts.insertEvent.run(
					eventId,
					event.room_id,
					this.streamCounter,
					JSON.stringify(event),
				);
			}

			let maxDepth = 0;
			const extremities: EventId[] = [];

			for (const event of stateEvents) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				this.stmts.insertEvent.run(
					eventId,
					event.room_id,
					this.streamCounter,
					JSON.stringify(event),
				);

				this.stmts.insertStateEvent.run(
					roomId,
					event.type,
					event.state_key ?? "",
					eventId,
					JSON.stringify(event),
				);

				if (event.depth > maxDepth) maxDepth = event.depth;
				extremities.length = 0;
				extremities.push(eventId);
			}

			this.db
				.prepare(
					"INSERT OR REPLACE INTO rooms (room_id, room_version, depth, forward_extremities) VALUES (?, ?, ?, ?)",
				)
				.run(roomId, roomVersion, maxDepth + 1, JSON.stringify(extremities));
		})();

		this.wakeWaiters();
	}
}
