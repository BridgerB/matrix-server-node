import * as mariadb from "mariadb";
import { computeEventId } from "../events.ts";
import type { CrossSigningKey, DeviceKeys, KeyBackupData, OneTimeKey } from "../types/e2ee.ts";
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

export class MysqlStorage extends EphemeralMixin implements Storage {
	private pool: mariadb.Pool;

	private constructor(pool: mariadb.Pool) {
		super();
		this.pool = pool;
	}

	static async create(connectionString: string): Promise<MysqlStorage> {
		const uri = connectionString.replace(/^mysql:\/\//, "mariadb://");
		const pool = mariadb.createPool(`${uri}?connectionLimit=20`);
		const storage = new MysqlStorage(pool);
		await storage.init();
		return storage;
	}

	private async query(sql: string, params?: unknown[]): Promise<unknown[]> {
		const rows = await this.pool.query(sql, params);
		return rows;
	}

	private async exec(
		sql: string,
		params?: unknown[],
	): Promise<mariadb.UpsertResult> {
		return await this.pool.query(sql, params);
	}

	private async init(): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(`
				CREATE TABLE IF NOT EXISTS users (
					user_id VARCHAR(255) PRIMARY KEY,
					localpart VARCHAR(255) UNIQUE NOT NULL,
					server_name VARCHAR(255) NOT NULL,
					password_hash TEXT NOT NULL,
					account_type VARCHAR(32) NOT NULL DEFAULT 'user',
					is_deactivated BOOLEAN NOT NULL DEFAULT FALSE,
					created_at BIGINT NOT NULL,
					displayname TEXT,
					avatar_url TEXT
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS sessions (
					access_token VARCHAR(255) PRIMARY KEY,
					refresh_token VARCHAR(255),
					device_id VARCHAR(255) NOT NULL,
					user_id VARCHAR(255) NOT NULL,
					access_token_hash VARCHAR(255),
					expires_at BIGINT,
					display_name TEXT,
					last_seen_ip VARCHAR(255),
					last_seen_ts BIGINT,
					user_agent TEXT,
					INDEX idx_sessions_user (user_id),
					INDEX idx_sessions_refresh (refresh_token),
					INDEX idx_sessions_device (user_id, device_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS uiaa_sessions (
					session_id VARCHAR(255) PRIMARY KEY,
					completed JSON NOT NULL
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS rooms (
					room_id VARCHAR(255) PRIMARY KEY,
					room_version VARCHAR(32) NOT NULL,
					depth INT NOT NULL DEFAULT 0,
					forward_extremities JSON NOT NULL
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS events (
					event_id VARCHAR(255) PRIMARY KEY,
					room_id VARCHAR(255) NOT NULL,
					stream_pos BIGINT NOT NULL,
					event_json JSON NOT NULL,
					INDEX idx_events_room (room_id),
					INDEX idx_events_stream (room_id, stream_pos)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS state_events (
					room_id VARCHAR(255) NOT NULL,
					event_type VARCHAR(255) NOT NULL,
					state_key VARCHAR(255) NOT NULL,
					event_id VARCHAR(255) NOT NULL,
					event_json JSON NOT NULL,
					PRIMARY KEY (room_id, event_type, state_key)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS txn_map (
					user_id VARCHAR(255) NOT NULL,
					device_id VARCHAR(255) NOT NULL,
					txn_id VARCHAR(255) NOT NULL,
					event_id VARCHAR(255) NOT NULL,
					PRIMARY KEY (user_id, device_id, txn_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS room_aliases (
					room_alias VARCHAR(255) PRIMARY KEY,
					room_id VARCHAR(255) NOT NULL,
					servers JSON NOT NULL,
					creator VARCHAR(255) NOT NULL
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS room_directory (
					room_id VARCHAR(255) PRIMARY KEY,
					visibility VARCHAR(32) NOT NULL DEFAULT 'private'
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS global_account_data (
					user_id VARCHAR(255) NOT NULL,
					type VARCHAR(255) NOT NULL,
					content JSON NOT NULL,
					PRIMARY KEY (user_id, type)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS room_account_data (
					user_id VARCHAR(255) NOT NULL,
					room_id VARCHAR(255) NOT NULL,
					type VARCHAR(255) NOT NULL,
					content JSON NOT NULL,
					PRIMARY KEY (user_id, room_id, type)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS receipts (
					room_id VARCHAR(255) NOT NULL,
					user_id VARCHAR(255) NOT NULL,
					event_id VARCHAR(255) NOT NULL,
					receipt_type VARCHAR(255) NOT NULL,
					ts BIGINT NOT NULL,
					PRIMARY KEY (room_id, user_id, receipt_type)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS media (
					origin VARCHAR(255) NOT NULL,
					media_id VARCHAR(255) NOT NULL,
					user_id VARCHAR(255),
					content_type VARCHAR(255) NOT NULL,
					upload_name TEXT,
					file_size BIGINT NOT NULL,
					content_hash VARCHAR(255) NOT NULL,
					created_at BIGINT NOT NULL,
					quarantined BOOLEAN NOT NULL DEFAULT FALSE,
					data LONGBLOB NOT NULL,
					PRIMARY KEY (origin, media_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS filters (
					user_id VARCHAR(255) NOT NULL,
					filter_id BIGINT NOT NULL,
					filter_json JSON NOT NULL,
					PRIMARY KEY (user_id, filter_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS device_keys (
					user_id VARCHAR(255) NOT NULL,
					device_id VARCHAR(255) NOT NULL,
					keys_json JSON NOT NULL,
					PRIMARY KEY (user_id, device_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS one_time_keys (
					user_id VARCHAR(255) NOT NULL,
					device_id VARCHAR(255) NOT NULL,
					key_id VARCHAR(255) NOT NULL,
					algorithm VARCHAR(64) NOT NULL,
					key_json JSON NOT NULL,
					PRIMARY KEY (user_id, device_id, key_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS fallback_keys (
					user_id VARCHAR(255) NOT NULL,
					device_id VARCHAR(255) NOT NULL,
					key_id VARCHAR(255) NOT NULL,
					key_json JSON NOT NULL,
					PRIMARY KEY (user_id, device_id, key_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS to_device (
					id BIGINT AUTO_INCREMENT PRIMARY KEY,
					user_id VARCHAR(255) NOT NULL,
					device_id VARCHAR(255) NOT NULL,
					event_json JSON NOT NULL,
					INDEX idx_to_device (user_id, device_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS pushers (
					user_id VARCHAR(255) NOT NULL,
					app_id VARCHAR(255) NOT NULL,
					pushkey VARCHAR(255) NOT NULL,
					pusher_json JSON NOT NULL,
					PRIMARY KEY (user_id, app_id, pushkey)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS relations (
					event_id VARCHAR(255) NOT NULL,
					room_id VARCHAR(255) NOT NULL,
					rel_type VARCHAR(255) NOT NULL,
					target_event_id VARCHAR(255) NOT NULL,
					\`key\` VARCHAR(255),
					sender VARCHAR(255) NOT NULL,
					event_type VARCHAR(255) NOT NULL,
					stream_pos BIGINT NOT NULL,
					INDEX idx_relations_target (target_event_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS reports (
					id BIGINT AUTO_INCREMENT PRIMARY KEY,
					user_id VARCHAR(255) NOT NULL,
					room_id VARCHAR(255) NOT NULL,
					event_id VARCHAR(255) NOT NULL,
					score INT,
					reason TEXT,
					ts BIGINT NOT NULL
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS openid_tokens (
					token VARCHAR(255) PRIMARY KEY,
					user_id VARCHAR(255) NOT NULL,
					expires_at BIGINT NOT NULL
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS threepids (
					user_id VARCHAR(255) NOT NULL,
					medium VARCHAR(255) NOT NULL,
					address VARCHAR(255) NOT NULL,
					added_at BIGINT NOT NULL,
					PRIMARY KEY (user_id, medium, address)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS server_keys (
					server_name VARCHAR(255) NOT NULL,
					key_id VARCHAR(255) NOT NULL,
					\`key\` TEXT NOT NULL,
					valid_until BIGINT NOT NULL,
					PRIMARY KEY (server_name, key_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS federation_txns (
					origin VARCHAR(255) NOT NULL,
					txn_id VARCHAR(255) NOT NULL,
					PRIMARY KEY (origin, txn_id)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS cross_signing_keys (
					user_id VARCHAR(255) NOT NULL,
					key_type VARCHAR(64) NOT NULL,
					key_json TEXT NOT NULL,
					PRIMARY KEY (user_id, key_type)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS key_backup_versions (
					id INT AUTO_INCREMENT PRIMARY KEY,
					user_id VARCHAR(255) NOT NULL,
					version VARCHAR(64) NOT NULL,
					algorithm VARCHAR(255) NOT NULL,
					auth_data TEXT NOT NULL,
					UNIQUE KEY (user_id, version)
				)
			`);

			await conn.query(`
				CREATE TABLE IF NOT EXISTS key_backup_data (
					user_id VARCHAR(255) NOT NULL,
					version VARCHAR(64) NOT NULL,
					room_id VARCHAR(255) NOT NULL,
					session_id VARCHAR(255) NOT NULL,
					key_json TEXT NOT NULL,
					PRIMARY KEY (user_id, version, room_id, session_id)
				)
			`);
		} finally {
			conn.release();
		}

		const [maxPos] = (await this.query(
			"SELECT MAX(stream_pos) AS m FROM events",
		)) as { m: number | null }[];
		this.streamCounter = maxPos?.m ?? 0;

		const [maxFilter] = (await this.query(
			"SELECT MAX(filter_id) AS m FROM filters",
		)) as { m: number | null }[];
		this.filterCounter = maxFilter?.m ?? 0;
	}

	private json(val: unknown): string {
		return JSON.stringify(val);
	}

	private parseJson(val: unknown): unknown {
		if (typeof val === "string") return JSON.parse(val);
		return val;
	}

	async createUser(account: UserAccount): Promise<void> {
		await this.exec(
			`INSERT INTO users (user_id, localpart, server_name, password_hash, account_type, is_deactivated, created_at, displayname, avatar_url)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
				localpart = VALUES(localpart), server_name = VALUES(server_name), password_hash = VALUES(password_hash),
				account_type = VALUES(account_type), is_deactivated = VALUES(is_deactivated), created_at = VALUES(created_at),
				displayname = VALUES(displayname), avatar_url = VALUES(avatar_url)`,
			[
				account.user_id,
				account.localpart,
				account.server_name,
				account.password_hash,
				account.account_type,
				account.is_deactivated ?? false,
				account.created_at,
				account.displayname ?? null,
				account.avatar_url ?? null,
			],
		);
	}

	async getUserByLocalpart(
		localpart: string,
	): Promise<UserAccount | undefined> {
		const rows = (await this.query("SELECT * FROM users WHERE localpart = ?", [
			localpart,
		])) as Record<string, unknown>[];
		return rows[0] ? rowToUser(rows[0]) : undefined;
	}

	async getUserById(userId: UserId): Promise<UserAccount | undefined> {
		const rows = (await this.query("SELECT * FROM users WHERE user_id = ?", [
			userId,
		])) as Record<string, unknown>[];
		return rows[0] ? rowToUser(rows[0]) : undefined;
	}

	async createSession(session: StoredSession): Promise<void> {
		await this.exec(
			`INSERT INTO sessions (access_token, refresh_token, device_id, user_id, access_token_hash, expires_at, display_name, last_seen_ip, last_seen_ts, user_agent)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
				refresh_token = VALUES(refresh_token), device_id = VALUES(device_id), user_id = VALUES(user_id),
				access_token_hash = VALUES(access_token_hash), expires_at = VALUES(expires_at), display_name = VALUES(display_name),
				last_seen_ip = VALUES(last_seen_ip), last_seen_ts = VALUES(last_seen_ts), user_agent = VALUES(user_agent)`,
			[
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
			],
		);
	}

	async getSessionByAccessToken(
		token: AccessToken,
	): Promise<StoredSession | undefined> {
		const rows = (await this.query(
			"SELECT * FROM sessions WHERE access_token = ?",
			[token],
		)) as Record<string, unknown>[];
		return rows[0] ? rowToSession(rows[0]) : undefined;
	}

	async getSessionByRefreshToken(
		token: RefreshToken,
	): Promise<StoredSession | undefined> {
		const rows = (await this.query(
			"SELECT * FROM sessions WHERE refresh_token = ?",
			[token],
		)) as Record<string, unknown>[];
		return rows[0] ? rowToSession(rows[0]) : undefined;
	}

	async getSessionsByUser(userId: UserId): Promise<StoredSession[]> {
		const rows = (await this.query("SELECT * FROM sessions WHERE user_id = ?", [
			userId,
		])) as Record<string, unknown>[];
		return rows.map((r) => rowToSession(r));
	}

	async deleteSession(token: AccessToken): Promise<void> {
		await this.exec("DELETE FROM sessions WHERE access_token = ?", [token]);
	}

	async deleteAllSessions(userId: UserId): Promise<void> {
		await this.exec("DELETE FROM sessions WHERE user_id = ?", [userId]);
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
		await this.exec(
			"UPDATE sessions SET last_seen_ip = ?, last_seen_ts = ?, user_agent = ? WHERE access_token = ?",
			[ip, Date.now(), userAgent, token],
		);
	}

	async createUIAASession(sessionId: string): Promise<void> {
		await this.exec(
			"INSERT INTO uiaa_sessions (session_id, completed) VALUES (?, '[]') ON DUPLICATE KEY UPDATE completed = '[]'",
			[sessionId],
		);
	}

	async getUIAASession(
		sessionId: string,
	): Promise<{ completed: string[] } | undefined> {
		const rows = (await this.query(
			"SELECT completed FROM uiaa_sessions WHERE session_id = ?",
			[sessionId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return { completed: this.parseJson(rows[0].completed) as string[] };
	}

	async addUIAACompleted(sessionId: string, stageType: string): Promise<void> {
		await this.exec(
			"UPDATE uiaa_sessions SET completed = JSON_ARRAY_APPEND(completed, '$', ?) WHERE session_id = ?",
			[stageType, sessionId],
		);
	}

	async deleteUIAASession(sessionId: string): Promise<void> {
		await this.exec("DELETE FROM uiaa_sessions WHERE session_id = ?", [
			sessionId,
		]);
	}

	async createRoom(state: RoomState): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			await conn.query(
				`INSERT INTO rooms (room_id, room_version, depth, forward_extremities) VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE room_version = VALUES(room_version), depth = VALUES(depth), forward_extremities = VALUES(forward_extremities)`,
				[
					state.room_id,
					state.room_version,
					state.depth,
					this.json(state.forward_extremities),
				],
			);
			for (const [key, event] of state.state_events) {
				const [eventType, stateKey] = key.split("\0") as [string, string];
				const eventId = computeEventId(event);
				await conn.query(
					`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES (?, ?, ?, ?, ?)
					 ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), event_json = VALUES(event_json)`,
					[state.room_id, eventType, stateKey, eventId, this.json(event)],
				);
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
		this.roomCache.set(state.room_id, state);
	}

	async getRoom(roomId: RoomId): Promise<RoomState | undefined> {
		const cached = this.roomCache.get(roomId);
		if (cached) return cached;

		const rows = (await this.query("SELECT * FROM rooms WHERE room_id = ?", [
			roomId,
		])) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		const row = rows[0];

		const stateRows = (await this.query(
			"SELECT event_type, state_key, event_json FROM state_events WHERE room_id = ?",
			[roomId],
		)) as Record<string, unknown>[];
		const stateMap = new Map<string, PDU>();
		for (const sr of stateRows) {
			stateMap.set(
				`${sr.event_type}\0${sr.state_key}`,
				this.parseJson(sr.event_json) as PDU,
			);
		}

		const room: RoomState = {
			room_id: row.room_id as RoomId,
			room_version: row.room_version as RoomVersion,
			state_events: stateMap,
			depth: Number(row.depth),
			forward_extremities: this.parseJson(row.forward_extremities) as EventId[],
		};
		this.roomCache.set(roomId, room);
		return room;
	}

	async getRoomsForUser(userId: UserId): Promise<RoomId[]> {
		const rows = (await this.query(
			"SELECT room_id FROM state_events WHERE event_type = 'm.room.member' AND state_key = ? AND JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.content.membership')) = 'join'",
			[userId],
		)) as Record<string, unknown>[];
		return rows.map((r) => r.room_id as RoomId);
	}

	async storeEvent(event: PDU, eventId: EventId): Promise<void> {
		this.streamCounter++;
		await this.exec(
			`INSERT INTO events (event_id, room_id, stream_pos, event_json) VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE room_id = VALUES(room_id), stream_pos = VALUES(stream_pos), event_json = VALUES(event_json)`,
			[eventId, event.room_id, this.streamCounter, this.json(event)],
		);
		this.wakeWaiters();
	}

	async getEvent(
		eventId: EventId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const rows = (await this.query(
			"SELECT event_id, event_json FROM events WHERE event_id = ?",
			[eventId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			event: this.parseJson(rows[0].event_json) as PDU,
			eventId: rows[0].event_id as EventId,
		};
	}

	async getEventsByRoom(
		roomId: RoomId,
		limit: number,
		from?: number,
		direction: "b" | "f" = "f",
	): Promise<{ events: { event: PDU; eventId: EventId }[]; end?: number }> {
		const fromPos = from ?? (direction === "f" ? 0 : this.streamCounter + 1);
		let rows: Record<string, unknown>[];

		if (direction === "f") {
			rows = (await this.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos ASC LIMIT ?",
				[roomId, fromPos, limit],
			)) as Record<string, unknown>[];
		} else {
			rows = (await this.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos < ? ORDER BY stream_pos DESC LIMIT ?",
				[roomId, fromPos, limit],
			)) as Record<string, unknown>[];
		}

		const events = rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
			eventId: r.event_id as EventId,
		}));
		const lastRow = rows[rows.length - 1];
		const end = lastRow ? Number(lastRow.stream_pos) : undefined;
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
		const rows = (await this.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = ? AND event_type = ? AND state_key = ?",
			[roomId, eventType, stateKey],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			event: this.parseJson(rows[0].event_json) as PDU,
			eventId: rows[0].event_id as EventId,
		};
	}

	async getAllState(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const rows = (await this.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = ?",
			[roomId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
			eventId: r.event_id as EventId,
		}));
	}

	async setStateEvent(
		roomId: RoomId,
		event: PDU,
		eventId: EventId,
	): Promise<void> {
		await this.exec(
			`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES (?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), event_json = VALUES(event_json)`,
			[roomId, event.type, event.state_key ?? "", eventId, this.json(event)],
		);

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
		const rows = (await this.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = ? AND event_type = 'm.room.member'",
			[roomId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
			eventId: r.event_id as EventId,
		}));
	}

	async getTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
	): Promise<EventId | undefined> {
		const rows = (await this.query(
			"SELECT event_id FROM txn_map WHERE user_id = ? AND device_id = ? AND txn_id = ?",
			[userId, deviceId, txnId],
		)) as Record<string, unknown>[];
		return rows[0] ? (rows[0].event_id as EventId) : undefined;
	}

	async setTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
		eventId: EventId,
	): Promise<void> {
		await this.exec(
			"INSERT INTO txn_map (user_id, device_id, txn_id, event_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)",
			[userId, deviceId, txnId, eventId],
		);
	}

	async getRoomsForUserWithMembership(
		userId: UserId,
	): Promise<{ roomId: RoomId; membership: string }[]> {
		const rows = (await this.query(
			"SELECT room_id, JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.content.membership')) AS membership FROM state_events WHERE event_type = 'm.room.member' AND state_key = ?",
			[userId],
		)) as Record<string, unknown>[];
		return rows
			.filter((r) => r.membership)
			.map((r) => ({
				roomId: r.room_id as RoomId,
				membership: r.membership as string,
			}));
	}

	async getEventsByRoomSince(
		roomId: RoomId,
		since: number,
		limit: number,
	): Promise<{
		events: { event: PDU; eventId: EventId; streamPos: number }[];
		limited: boolean;
	}> {
		const [countRow] = (await this.query(
			"SELECT COUNT(*) AS cnt FROM events WHERE room_id = ? AND stream_pos > ?",
			[roomId, since],
		)) as Record<string, unknown>[];
		const total = Number(countRow?.cnt);
		const limited = total > limit;

		let rows: Record<string, unknown>[];
		if (limited) {
			rows = (await this.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos DESC LIMIT ?",
				[roomId, since, limit],
			)) as Record<string, unknown>[];
			rows.reverse();
		} else {
			rows = (await this.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ? AND stream_pos > ? ORDER BY stream_pos ASC",
				[roomId, since],
			)) as Record<string, unknown>[];
		}

		const events = rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
			eventId: r.event_id as EventId,
			streamPos: Number(r.stream_pos),
		}));
		return { events, limited };
	}

	async getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]> {
		const placeholders = INVITE_STATE_TYPES.map(() => "?").join(",");
		const rows = (await this.query(
			`SELECT event_json FROM state_events WHERE room_id = ? AND event_type IN (${placeholders})`,
			[roomId, ...INVITE_STATE_TYPES],
		)) as Record<string, unknown>[];
		return rows.map((r) => {
			const event = this.parseJson(r.event_json) as PDU;
			return eventToStrippedState(event);
		});
	}

	async getProfile(userId: UserId): Promise<UserProfile | undefined> {
		const rows = (await this.query(
			"SELECT displayname, avatar_url FROM users WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		const profile: UserProfile = {};
		if (rows[0].displayname)
			profile.displayname = rows[0].displayname as string;
		if (rows[0].avatar_url) profile.avatar_url = rows[0].avatar_url as string;
		return profile;
	}

	async setDisplayName(
		userId: UserId,
		displayname: string | null,
	): Promise<void> {
		await this.exec("UPDATE users SET displayname = ? WHERE user_id = ?", [
			displayname,
			userId,
		]);
	}

	async setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void> {
		await this.exec("UPDATE users SET avatar_url = ? WHERE user_id = ?", [
			avatarUrl,
			userId,
		]);
	}

	async getDevice(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Device | undefined> {
		const rows = (await this.query(
			"SELECT device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = ? AND device_id = ? LIMIT 1",
			[userId, deviceId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			device_id: rows[0].device_id as DeviceId,
			display_name: (rows[0].display_name as string) ?? undefined,
			last_seen_ip: (rows[0].last_seen_ip as string) ?? undefined,
			last_seen_ts: rows[0].last_seen_ts
				? Number(rows[0].last_seen_ts)
				: undefined,
		};
	}

	async getAllDevices(userId: UserId): Promise<Device[]> {
		const rows = (await this.query(
			"SELECT device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = ? GROUP BY device_id, display_name, last_seen_ip, last_seen_ts",
			[userId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			device_id: r.device_id as DeviceId,
			display_name: (r.display_name as string) ?? undefined,
			last_seen_ip: (r.last_seen_ip as string) ?? undefined,
			last_seen_ts: r.last_seen_ts ? Number(r.last_seen_ts) : undefined,
		}));
	}

	async updateDeviceDisplayName(
		userId: UserId,
		deviceId: DeviceId,
		displayName: string,
	): Promise<void> {
		await this.exec(
			"UPDATE sessions SET display_name = ? WHERE user_id = ? AND device_id = ?",
			[displayName, userId, deviceId],
		);
	}

	async deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void> {
		await this.exec(
			"DELETE FROM sessions WHERE user_id = ? AND device_id = ?",
			[userId, deviceId],
		);
	}

	async updatePassword(userId: UserId, newPasswordHash: string): Promise<void> {
		await this.exec("UPDATE users SET password_hash = ? WHERE user_id = ?", [
			newPasswordHash,
			userId,
		]);
	}

	async deactivateUser(userId: UserId): Promise<void> {
		await this.exec(
			"UPDATE users SET is_deactivated = TRUE WHERE user_id = ?",
			[userId],
		);
		await this.deleteAllSessions(userId);
	}

	async createRoomAlias(
		roomAlias: RoomAlias,
		roomId: RoomId,
		servers: ServerName[],
		creator: UserId,
	): Promise<void> {
		await this.exec(
			"INSERT INTO room_aliases (room_alias, room_id, servers, creator) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE room_id = VALUES(room_id), servers = VALUES(servers), creator = VALUES(creator)",
			[roomAlias, roomId, this.json(servers), creator],
		);
	}

	async deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean> {
		const result = await this.exec(
			"DELETE FROM room_aliases WHERE room_alias = ?",
			[roomAlias],
		);
		return (result.affectedRows ?? 0) > 0;
	}

	async getRoomByAlias(
		roomAlias: RoomAlias,
	): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined> {
		const rows = (await this.query(
			"SELECT room_id, servers FROM room_aliases WHERE room_alias = ?",
			[roomAlias],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			room_id: rows[0].room_id as RoomId,
			servers: this.parseJson(rows[0].servers) as ServerName[],
		};
	}

	async getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]> {
		const rows = (await this.query(
			"SELECT room_alias FROM room_aliases WHERE room_id = ?",
			[roomId],
		)) as Record<string, unknown>[];
		return rows.map((r) => r.room_alias as RoomAlias);
	}

	async getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined> {
		const rows = (await this.query(
			"SELECT creator FROM room_aliases WHERE room_alias = ?",
			[roomAlias],
		)) as Record<string, unknown>[];
		return rows[0] ? (rows[0].creator as UserId) : undefined;
	}

	async setRoomVisibility(
		roomId: RoomId,
		visibility: "public" | "private",
	): Promise<void> {
		await this.exec(
			"INSERT INTO room_directory (room_id, visibility) VALUES (?, ?) ON DUPLICATE KEY UPDATE visibility = VALUES(visibility)",
			[roomId, visibility],
		);
	}

	async getRoomVisibility(roomId: RoomId): Promise<"public" | "private"> {
		const rows = (await this.query(
			"SELECT visibility FROM room_directory WHERE room_id = ?",
			[roomId],
		)) as Record<string, unknown>[];
		return (rows[0]?.visibility as "public" | "private") ?? "private";
	}

	async getPublicRoomIds(): Promise<RoomId[]> {
		const rows = (await this.query(
			"SELECT room_id FROM room_directory WHERE visibility = 'public'",
		)) as Record<string, unknown>[];
		return rows.map((r) => r.room_id as RoomId);
	}

	async getGlobalAccountData(
		userId: UserId,
		type: string,
	): Promise<JsonObject | undefined> {
		const rows = (await this.query(
			"SELECT content FROM global_account_data WHERE user_id = ? AND type = ?",
			[userId, type],
		)) as Record<string, unknown>[];
		return rows[0]
			? (this.parseJson(rows[0].content) as JsonObject)
			: undefined;
	}

	async setGlobalAccountData(
		userId: UserId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		await this.exec(
			"INSERT INTO global_account_data (user_id, type, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)",
			[userId, type, this.json(content)],
		);
	}

	async getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const rows = (await this.query(
			"SELECT type, content FROM global_account_data WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			type: r.type as string,
			content: this.parseJson(r.content) as JsonObject,
		}));
	}

	async getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined> {
		const rows = (await this.query(
			"SELECT content FROM room_account_data WHERE user_id = ? AND room_id = ? AND type = ?",
			[userId, roomId, type],
		)) as Record<string, unknown>[];
		return rows[0]
			? (this.parseJson(rows[0].content) as JsonObject)
			: undefined;
	}

	async setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		await this.exec(
			"INSERT INTO room_account_data (user_id, room_id, type, content) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)",
			[userId, roomId, type, this.json(content)],
		);
	}

	async getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const rows = (await this.query(
			"SELECT type, content FROM room_account_data WHERE user_id = ? AND room_id = ?",
			[userId, roomId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			type: r.type as string,
			content: this.parseJson(r.content) as JsonObject,
		}));
	}

	async setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
	): Promise<void> {
		await this.exec(
			"INSERT INTO receipts (room_id, user_id, event_id, receipt_type, ts) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), ts = VALUES(ts)",
			[roomId, userId, eventId, receiptType, ts],
		);
		this.wakeWaiters();
	}

	async getReceipts(
		roomId: RoomId,
	): Promise<
		{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]
	> {
		const rows = (await this.query(
			"SELECT event_id, receipt_type, user_id, ts FROM receipts WHERE room_id = ?",
			[roomId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			eventId: r.event_id as EventId,
			receiptType: r.receipt_type as string,
			userId: r.user_id as UserId,
			ts: Number(r.ts),
		}));
	}

	async storeMedia(media: StoredMedia, data: Buffer): Promise<void> {
		await this.exec(
			`INSERT INTO media (origin, media_id, user_id, content_type, upload_name, file_size, content_hash, created_at, quarantined, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), content_type = VALUES(content_type), upload_name = VALUES(upload_name),
				file_size = VALUES(file_size), content_hash = VALUES(content_hash), created_at = VALUES(created_at), quarantined = VALUES(quarantined), data = VALUES(data)`,
			[
				media.origin,
				media.media_id,
				media.user_id ?? null,
				media.content_type,
				media.upload_name ?? null,
				media.file_size,
				media.content_hash,
				media.created_at,
				media.quarantined ?? false,
				data,
			],
		);
	}

	async getMedia(
		serverName: ServerName,
		mediaId: string,
	): Promise<{ metadata: StoredMedia; data: Buffer } | undefined> {
		const rows = (await this.query(
			"SELECT * FROM media WHERE origin = ? AND media_id = ?",
			[serverName, mediaId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		const row = rows[0];
		return {
			metadata: {
				media_id: row.media_id as string,
				origin: row.origin as ServerName,
				user_id: (row.user_id as string) ?? undefined,
				content_type: row.content_type as string,
				upload_name: (row.upload_name as string) ?? undefined,
				file_size: Number(row.file_size),
				content_hash: row.content_hash as string,
				created_at: Number(row.created_at),
				quarantined: Boolean(row.quarantined),
			},
			data: row.data as Buffer,
		};
	}

	async reserveMedia(media: StoredMedia): Promise<void> {
		await this.storeMedia(media, Buffer.alloc(0));
	}

	async updateMediaContent(
		serverName: ServerName,
		mediaId: string,
		contentType: string,
		fileName: string | undefined,
		data: Buffer,
	): Promise<boolean> {
		const existing = await this.getMedia(serverName, mediaId);
		if (!existing) return false;
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update(data).digest("base64");
		await this.exec(
			"UPDATE media SET content_type = ?, upload_name = ?, file_size = ?, content_hash = ?, data = ? WHERE origin = ? AND media_id = ?",
			[contentType, fileName ?? null, data.length, hash, data, serverName, mediaId],
		);
		return true;
	}

	async createFilter(userId: UserId, filter: JsonObject): Promise<string> {
		const filterId = String(++this.filterCounter);
		await this.exec(
			"INSERT INTO filters (user_id, filter_id, filter_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE filter_json = VALUES(filter_json)",
			[userId, filterId, this.json(filter)],
		);
		return filterId;
	}

	async getFilter(
		userId: UserId,
		filterId: string,
	): Promise<JsonObject | undefined> {
		const rows = (await this.query(
			"SELECT filter_json FROM filters WHERE user_id = ? AND filter_id = ?",
			[userId, filterId],
		)) as Record<string, unknown>[];
		return rows[0]
			? (this.parseJson(rows[0].filter_json) as JsonObject)
			: undefined;
	}

	async setDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: DeviceKeys,
	): Promise<void> {
		await this.exec(
			"INSERT INTO device_keys (user_id, device_id, keys_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE keys_json = VALUES(keys_json)",
			[userId, deviceId, this.json(keys)],
		);
	}

	async getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined> {
		const rows = (await this.query(
			"SELECT keys_json FROM device_keys WHERE user_id = ? AND device_id = ?",
			[userId, deviceId],
		)) as Record<string, unknown>[];
		return rows[0]
			? (this.parseJson(rows[0].keys_json) as DeviceKeys)
			: undefined;
	}

	async getAllDeviceKeys(
		userId: UserId,
	): Promise<Record<DeviceId, DeviceKeys>> {
		const rows = (await this.query(
			"SELECT device_id, keys_json FROM device_keys WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		const result: Record<DeviceId, DeviceKeys> = {};
		for (const r of rows)
			result[r.device_id as DeviceId] = this.parseJson(
				r.keys_json,
			) as DeviceKeys;
		return result;
	}

	async addOneTimeKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			for (const [keyId, key] of Object.entries(keys)) {
				const algorithm = keyId.split(":")[0] as string;
				await conn.query(
					"INSERT INTO one_time_keys (user_id, device_id, key_id, algorithm, key_json) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE key_json = VALUES(key_json)",
					[userId, deviceId, keyId, algorithm, this.json(key)],
				);
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
	}

	async claimOneTimeKey(
		userId: UserId,
		deviceId: DeviceId,
		algorithm: string,
	): Promise<{ keyId: KeyId; key: string | OneTimeKey } | undefined> {
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			const rows = (await conn.query(
				"SELECT key_id, key_json FROM one_time_keys WHERE user_id = ? AND device_id = ? AND algorithm = ? LIMIT 1",
				[userId, deviceId, algorithm],
			)) as Record<string, unknown>[];
			if (rows[0]) {
				await conn.query(
					"DELETE FROM one_time_keys WHERE user_id = ? AND device_id = ? AND key_id = ?",
					[userId, deviceId, rows[0].key_id],
				);
				await conn.commit();
				return {
					keyId: rows[0].key_id as KeyId,
					key: this.parseJson(rows[0].key_json) as string | OneTimeKey,
				};
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}

		const fallbackRows = (await this.query(
			"SELECT key_id, key_json FROM fallback_keys WHERE user_id = ? AND device_id = ? AND key_id LIKE ? LIMIT 1",
			[userId, deviceId, `${algorithm}:%`],
		)) as Record<string, unknown>[];
		if (fallbackRows[0])
			return {
				keyId: fallbackRows[0].key_id as KeyId,
				key: this.parseJson(fallbackRows[0].key_json) as string | OneTimeKey,
			};
		return undefined;
	}

	async getOneTimeKeyCounts(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Record<string, number>> {
		const rows = (await this.query(
			"SELECT algorithm, COUNT(*) AS cnt FROM one_time_keys WHERE user_id = ? AND device_id = ? GROUP BY algorithm",
			[userId, deviceId],
		)) as Record<string, unknown>[];
		const counts: Record<string, number> = {};
		for (const r of rows) counts[r.algorithm as string] = Number(r.cnt);
		return counts;
	}

	async setFallbackKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			await conn.query(
				"DELETE FROM fallback_keys WHERE user_id = ? AND device_id = ?",
				[userId, deviceId],
			);
			for (const [keyId, key] of Object.entries(keys)) {
				await conn.query(
					"INSERT INTO fallback_keys (user_id, device_id, key_id, key_json) VALUES (?, ?, ?, ?)",
					[userId, deviceId, keyId, this.json(key)],
				);
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
	}

	async getFallbackKeyTypes(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<string[]> {
		const rows = (await this.query(
			"SELECT DISTINCT key_id FROM fallback_keys WHERE user_id = ? AND device_id = ?",
			[userId, deviceId],
		)) as Record<string, unknown>[];
		const types = new Set<string>();
		for (const r of rows)
			types.add((r.key_id as string).split(":")[0] as string);
		return [...types];
	}

	async setCrossSigningKeys(
		userId: UserId,
		keys: {
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
		},
	): Promise<void> {
		const entries: [string, CrossSigningKey][] = [];
		if (keys.master_key) entries.push(["master_key", keys.master_key]);
		if (keys.self_signing_key)
			entries.push(["self_signing_key", keys.self_signing_key]);
		if (keys.user_signing_key)
			entries.push(["user_signing_key", keys.user_signing_key]);
		for (const [keyType, key] of entries) {
			await this.exec(
				"INSERT INTO cross_signing_keys (user_id, key_type, key_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE key_json = VALUES(key_json)",
				[userId, keyType, this.json(key)],
			);
		}
	}

	async getCrossSigningKeys(userId: UserId): Promise<{
		master_key?: CrossSigningKey;
		self_signing_key?: CrossSigningKey;
		user_signing_key?: CrossSigningKey;
	}> {
		const rows = (await this.query(
			"SELECT key_type, key_json FROM cross_signing_keys WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		const result: {
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
		} = {};
		for (const r of rows) {
			const keyType = r.key_type as string;
			const key = this.parseJson(r.key_json) as CrossSigningKey;
			if (keyType === "master_key") result.master_key = key;
			else if (keyType === "self_signing_key") result.self_signing_key = key;
			else if (keyType === "user_signing_key") result.user_signing_key = key;
		}
		return result;
	}

	async storeCrossSigningSignatures(
		_userId: UserId,
		signatures: Record<string, Record<string, JsonObject>>,
	): Promise<
		Record<string, Record<string, { errcode: string; error: string }>>
	> {
		const failures: Record<
			string,
			Record<string, { errcode: string; error: string }>
		> = {};
		for (const [targetUserId, keyMap] of Object.entries(signatures)) {
			for (const [keyId, signedObject] of Object.entries(keyMap)) {
				const signedSigs = (
					signedObject as Record<string, unknown>
				).signatures as Record<string, Record<string, string>> | undefined;
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
					await this.setDeviceKeys(
						targetUserId as UserId,
						keyId as DeviceId,
						deviceKeys,
					);
					continue;
				}

				// Try updating cross-signing keys
				const crossKeys = await this.getCrossSigningKeys(
					targetUserId as UserId,
				);
				let matched = false;
				for (const [crossKeyType, key] of [
					["master_key", crossKeys.master_key],
					["self_signing_key", crossKeys.self_signing_key],
					["user_signing_key", crossKeys.user_signing_key],
				] as const) {
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
						await this.exec(
							"UPDATE cross_signing_keys SET key_json = ? WHERE user_id = ? AND key_type = ?",
							[this.json(key), targetUserId, crossKeyType],
						);
						matched = true;
						break;
					}
				}
				if (matched) continue;

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

	async createKeyBackupVersion(
		userId: UserId,
		algorithm: string,
		authData: JsonObject,
	): Promise<string> {
		const [maxRow] = (await this.query(
			"SELECT MAX(CAST(version AS UNSIGNED)) AS m FROM key_backup_versions WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		const version = String((Number(maxRow?.m) || 0) + 1);
		await this.exec(
			"INSERT INTO key_backup_versions (user_id, version, algorithm, auth_data) VALUES (?, ?, ?, ?)",
			[userId, version, algorithm, this.json(authData)],
		);
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
		let rows: Record<string, unknown>[];
		if (version) {
			rows = (await this.query(
				"SELECT version, algorithm, auth_data FROM key_backup_versions WHERE user_id = ? AND version = ?",
				[userId, version],
			)) as Record<string, unknown>[];
		} else {
			rows = (await this.query(
				"SELECT version, algorithm, auth_data FROM key_backup_versions WHERE user_id = ? ORDER BY CAST(version AS UNSIGNED) DESC LIMIT 1",
				[userId],
			)) as Record<string, unknown>[];
		}
		if (!rows[0]) return undefined;
		const v = rows[0];
		const ver = v.version as string;

		const [countRow] = (await this.query(
			"SELECT COUNT(*) AS cnt FROM key_backup_data WHERE user_id = ? AND version = ?",
			[userId, ver],
		)) as Record<string, unknown>[];
		const count = Number(countRow?.cnt ?? 0);

		return {
			version: ver,
			algorithm: v.algorithm as string,
			auth_data: this.parseJson(v.auth_data) as JsonObject,
			count,
			etag: await this.computeMysqlBackupEtag(userId, ver),
		};
	}

	private async computeMysqlBackupEtag(
		userId: UserId,
		version: string,
	): Promise<string> {
		const rows = (await this.query(
			"SELECT room_id, session_id FROM key_backup_data WHERE user_id = ? AND version = ?",
			[userId, version],
		)) as Record<string, unknown>[];
		if (rows.length === 0) return "0";
		let hash = 0;
		for (const r of rows) {
			for (const c of `${r.room_id}${r.session_id}`) {
				hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
			}
		}
		return String(Math.abs(hash));
	}

	async updateKeyBackupVersion(
		userId: UserId,
		version: string,
		authData: JsonObject,
	): Promise<boolean> {
		const result = await this.exec(
			"UPDATE key_backup_versions SET auth_data = ? WHERE user_id = ? AND version = ?",
			[this.json(authData), userId, version],
		);
		return (result as unknown as { affectedRows: number }).affectedRows > 0;
	}

	async deleteKeyBackupVersion(
		userId: UserId,
		version: string,
	): Promise<boolean> {
		await this.exec(
			"DELETE FROM key_backup_data WHERE user_id = ? AND version = ?",
			[userId, version],
		);
		const result = await this.exec(
			"DELETE FROM key_backup_versions WHERE user_id = ? AND version = ?",
			[userId, version],
		);
		return (result as unknown as { affectedRows: number }).affectedRows > 0;
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
					rooms: Record<
						RoomId,
						{ sessions: Record<string, KeyBackupData> }
					>;
			  },
	): Promise<{ count: number; etag: string } | undefined> {
		// Verify version exists and is the latest
		const [latestRow] = (await this.query(
			"SELECT version FROM key_backup_versions WHERE user_id = ? ORDER BY CAST(version AS UNSIGNED) DESC LIMIT 1",
			[userId],
		)) as Record<string, unknown>[];
		if (!latestRow || (latestRow.version as string) !== version) return undefined;

		const entries: [RoomId, string, KeyBackupData][] = [];
		if (roomId && sessionId) {
			entries.push([roomId, sessionId, keys as KeyBackupData]);
		} else if (roomId) {
			const roomKeys = keys as { sessions: Record<string, KeyBackupData> };
			for (const [sid, data] of Object.entries(roomKeys.sessions)) {
				entries.push([roomId, sid, data]);
			}
		} else {
			const allKeys = keys as {
				rooms: Record<
					RoomId,
					{ sessions: Record<string, KeyBackupData> }
				>;
			};
			for (const [rid, roomData] of Object.entries(allKeys.rooms)) {
				for (const [sid, data] of Object.entries(roomData.sessions)) {
					entries.push([rid as RoomId, sid, data]);
				}
			}
		}

		for (const [rid, sid, data] of entries) {
			// Check existing for merge priority
			const existingRows = (await this.query(
				"SELECT key_json FROM key_backup_data WHERE user_id = ? AND version = ? AND room_id = ? AND session_id = ?",
				[userId, version, rid, sid],
			)) as Record<string, unknown>[];
			if (existingRows[0]) {
				const existing = this.parseJson(existingRows[0].key_json) as KeyBackupData;
				if (
					!(data.is_verified && !existing.is_verified) &&
					!(data.is_verified === existing.is_verified &&
						data.first_message_index < existing.first_message_index) &&
					!(data.is_verified === existing.is_verified &&
						data.first_message_index === existing.first_message_index &&
						data.forwarded_count < existing.forwarded_count)
				) {
					continue;
				}
			}
			await this.exec(
				"INSERT INTO key_backup_data (user_id, version, room_id, session_id, key_json) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE key_json = VALUES(key_json)",
				[userId, version, rid, sid, this.json(data)],
			);
		}

		const [countRow] = (await this.query(
			"SELECT COUNT(*) AS cnt FROM key_backup_data WHERE user_id = ? AND version = ?",
			[userId, version],
		)) as Record<string, unknown>[];
		const count = Number(countRow?.cnt ?? 0);
		return { count, etag: await this.computeMysqlBackupEtag(userId, version) };
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
				rooms: Record<
					RoomId,
					{ sessions: Record<string, KeyBackupData> }
				>;
		  }
		| undefined
	> {
		if (roomId && sessionId) {
			const rows = (await this.query(
				"SELECT key_json FROM key_backup_data WHERE user_id = ? AND version = ? AND room_id = ? AND session_id = ?",
				[userId, version, roomId, sessionId],
			)) as Record<string, unknown>[];
			return rows[0]
				? (this.parseJson(rows[0].key_json) as KeyBackupData)
				: undefined;
		} else if (roomId) {
			const rows = (await this.query(
				"SELECT session_id, key_json FROM key_backup_data WHERE user_id = ? AND version = ? AND room_id = ?",
				[userId, version, roomId],
			)) as Record<string, unknown>[];
			const sessions: Record<string, KeyBackupData> = {};
			for (const r of rows) {
				sessions[r.session_id as string] = this.parseJson(
					r.key_json,
				) as KeyBackupData;
			}
			return { sessions };
		} else {
			const rows = (await this.query(
				"SELECT room_id, session_id, key_json FROM key_backup_data WHERE user_id = ? AND version = ?",
				[userId, version],
			)) as Record<string, unknown>[];
			const rooms: Record<
				RoomId,
				{ sessions: Record<string, KeyBackupData> }
			> = {};
			for (const r of rows) {
				const rid = r.room_id as RoomId;
				if (!rooms[rid]) rooms[rid] = { sessions: {} };
				(rooms[rid] as { sessions: Record<string, KeyBackupData> }).sessions[
					r.session_id as string
				] = this.parseJson(r.key_json) as KeyBackupData;
			}
			return { rooms };
		}
	}

	async deleteKeyBackupKeys(
		userId: UserId,
		version: string,
		roomId?: RoomId,
		sessionId?: string,
	): Promise<{ count: number; etag: string } | undefined> {
		// Verify version exists
		const [versionRow] = (await this.query(
			"SELECT version FROM key_backup_versions WHERE user_id = ? AND version = ?",
			[userId, version],
		)) as Record<string, unknown>[];
		if (!versionRow) return undefined;

		if (roomId && sessionId) {
			await this.exec(
				"DELETE FROM key_backup_data WHERE user_id = ? AND version = ? AND room_id = ? AND session_id = ?",
				[userId, version, roomId, sessionId],
			);
		} else if (roomId) {
			await this.exec(
				"DELETE FROM key_backup_data WHERE user_id = ? AND version = ? AND room_id = ?",
				[userId, version, roomId],
			);
		} else {
			await this.exec(
				"DELETE FROM key_backup_data WHERE user_id = ? AND version = ?",
				[userId, version],
			);
		}

		const [countRow] = (await this.query(
			"SELECT COUNT(*) AS cnt FROM key_backup_data WHERE user_id = ? AND version = ?",
			[userId, version],
		)) as Record<string, unknown>[];
		const count = Number(countRow?.cnt ?? 0);
		return { count, etag: await this.computeMysqlBackupEtag(userId, version) };
	}

	async sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void> {
		await this.exec(
			"INSERT INTO to_device (user_id, device_id, event_json) VALUES (?, ?, ?)",
			[userId, deviceId, this.json(event)],
		);
		this.wakeWaiters();
	}

	async getToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<ToDeviceEvent[]> {
		const rows = (await this.query(
			"SELECT event_json FROM to_device WHERE user_id = ? AND device_id = ? ORDER BY id",
			[userId, deviceId],
		)) as Record<string, unknown>[];
		return rows.map((r) => this.parseJson(r.event_json) as ToDeviceEvent);
	}

	async clearToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<void> {
		await this.exec(
			"DELETE FROM to_device WHERE user_id = ? AND device_id = ?",
			[userId, deviceId],
		);
	}

	async getPushers(userId: UserId): Promise<Pusher[]> {
		const rows = (await this.query(
			"SELECT pusher_json FROM pushers WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		return rows.map((r) => this.parseJson(r.pusher_json) as Pusher);
	}

	async setPusher(userId: UserId, pusher: Pusher): Promise<void> {
		await this.exec(
			"INSERT INTO pushers (user_id, app_id, pushkey, pusher_json) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pusher_json = VALUES(pusher_json)",
			[userId, pusher.app_id, pusher.pushkey, this.json(pusher)],
		);
	}

	async deletePusher(
		userId: UserId,
		appId: string,
		pushkey: string,
	): Promise<void> {
		await this.exec(
			"DELETE FROM pushers WHERE user_id = ? AND app_id = ? AND pushkey = ?",
			[userId, appId, pushkey],
		);
	}

	async deletePusherByKey(appId: string, pushkey: string): Promise<void> {
		await this.exec("DELETE FROM pushers WHERE app_id = ? AND pushkey = ?", [
			appId,
			pushkey,
		]);
	}

	async storeRelation(
		eventId: EventId,
		roomId: RoomId,
		relType: string,
		targetEventId: EventId,
		key?: string,
	): Promise<void> {
		const rows = (await this.query(
			"SELECT event_json, stream_pos FROM events WHERE event_id = ?",
			[eventId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return;
		const event = this.parseJson(rows[0].event_json) as PDU;
		const streamPos = Number(rows[0].stream_pos);
		await this.exec(
			"INSERT INTO relations (event_id, room_id, rel_type, target_event_id, `key`, sender, event_type, stream_pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				eventId,
				roomId,
				relType,
				targetEventId,
				key ?? null,
				event.sender,
				event.type,
				streamPos,
			],
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
			sql +=
				direction === "f" ? " AND r.stream_pos > ?" : " AND r.stream_pos < ?";
			params.push(fromPos);
		}

		sql +=
			direction === "f"
				? " ORDER BY r.stream_pos ASC LIMIT ?"
				: " ORDER BY r.stream_pos DESC LIMIT ?";
		params.push(limit);

		const rows = (await this.query(sql, params)) as Record<string, unknown>[];
		const events = rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
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
		const rows = (await this.query(
			"SELECT event_type, `key`, COUNT(*) AS cnt FROM relations WHERE target_event_id = ? AND rel_type = 'm.annotation' AND `key` IS NOT NULL GROUP BY event_type, `key`",
			[eventId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			type: r.event_type as string,
			key: r.key as string,
			count: Number(r.cnt),
		}));
	}

	async getLatestEdit(
		eventId: EventId,
		sender: UserId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const rows = (await this.query(
			"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = ? AND r.rel_type = 'm.replace' AND r.sender = ? ORDER BY r.stream_pos DESC LIMIT 1",
			[eventId, sender],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			event: this.parseJson(rows[0].event_json) as PDU,
			eventId: rows[0].event_id as EventId,
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
		const [countRow] = (await this.query(
			"SELECT COUNT(*) AS cnt FROM relations WHERE target_event_id = ? AND rel_type = 'm.thread'",
			[eventId],
		)) as Record<string, unknown>[];
		if (Number(countRow?.cnt) === 0) return undefined;

		const [latestRow] = (await this.query(
			"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = ? AND r.rel_type = 'm.thread' ORDER BY r.stream_pos DESC LIMIT 1",
			[eventId],
		)) as Record<string, unknown>[];
		if (!latestRow) return undefined;

		const participated = (await this.query(
			"SELECT 1 FROM relations WHERE target_event_id = ? AND rel_type = 'm.thread' AND sender = ? LIMIT 1",
			[eventId, userId],
		)) as Record<string, unknown>[];

		return {
			latestEvent: {
				event: this.parseJson(latestRow.event_json) as PDU,
				eventId: latestRow.event_id as EventId,
			},
			count: Number(countRow?.cnt),
			currentUserParticipated: participated.length > 0,
		};
	}

	async storeReport(
		userId: UserId,
		roomId: RoomId,
		eventId: EventId,
		score?: number,
		reason?: string,
	): Promise<void> {
		await this.exec(
			"INSERT INTO reports (user_id, room_id, event_id, score, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, roomId, eventId, score ?? null, reason ?? null, Date.now()],
		);
	}

	async storeOpenIdToken(
		token: string,
		userId: UserId,
		expiresAt: Timestamp,
	): Promise<void> {
		await this.exec(
			"INSERT INTO openid_tokens (token, user_id, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires_at = VALUES(expires_at)",
			[token, userId, expiresAt],
		);
	}

	async getOpenIdToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: Timestamp } | undefined> {
		const rows = (await this.query(
			"SELECT user_id, expires_at FROM openid_tokens WHERE token = ?",
			[token],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			userId: rows[0].user_id as UserId,
			expiresAt: Number(rows[0].expires_at),
		};
	}

	async getThreePids(
		userId: UserId,
	): Promise<{ medium: string; address: string; added_at: Timestamp }[]> {
		const rows = (await this.query(
			"SELECT medium, address, added_at FROM threepids WHERE user_id = ?",
			[userId],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			medium: r.medium as string,
			address: r.address as string,
			added_at: Number(r.added_at),
		}));
	}

	async addThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		await this.exec(
			"INSERT IGNORE INTO threepids (user_id, medium, address, added_at) VALUES (?, ?, ?, ?)",
			[userId, medium, address, Date.now()],
		);
	}

	async deleteThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		await this.exec(
			"DELETE FROM threepids WHERE user_id = ? AND medium = ? AND address = ?",
			[userId, medium, address],
		);
	}

	async searchUserDirectory(
		searchTerm: string,
		limit: number,
	): Promise<
		{ user_id: UserId; display_name?: string; avatar_url?: string }[]
	> {
		const term = `%${searchTerm}%`;
		const rows = (await this.query(
			"SELECT user_id, displayname, avatar_url FROM users WHERE is_deactivated = FALSE AND (user_id LIKE ? OR displayname LIKE ?) LIMIT ?",
			[term, term, limit],
		)) as Record<string, unknown>[];
		return rows.map((r) => ({
			user_id: r.user_id as UserId,
			display_name: (r.displayname as string) ?? undefined,
			avatar_url: (r.avatar_url as string) ?? undefined,
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
			SELECT r.target_event_id, MAX(r.stream_pos) AS latest_pos, e.event_json
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
		sql +=
			" GROUP BY r.target_event_id, e.event_json ORDER BY latest_pos DESC LIMIT ?";
		params.push(limit);

		const rows = (await this.query(sql, params)) as Record<string, unknown>[];
		const events = rows.map((r) => ({
			event: this.parseJson(r.event_json) as PDU,
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

		const rows = (await this.query(sql, params)) as Record<string, unknown>[];
		const term = searchTerm.toLowerCase();
		const results: { event: PDU; eventId: EventId; streamPos: number }[] = [];

		for (const row of rows) {
			if (results.length >= limit) break;
			const event = this.parseJson(row.event_json) as PDU;
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
			if (matched)
				results.push({
					event,
					eventId: row.event_id as EventId,
					streamPos: Number(row.stream_pos),
				});
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
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			for (const [keyId, val] of Object.entries(keys.verify_keys)) {
				await conn.query(
					"INSERT INTO server_keys (server_name, key_id, `key`, valid_until) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `key` = VALUES(`key`), valid_until = VALUES(valid_until)",
					[serverName, keyId, val.key, keys.valid_until_ts],
				);
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
	}

	async getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined> {
		const rows = (await this.query(
			"SELECT `key`, valid_until FROM server_keys WHERE server_name = ? AND key_id = ?",
			[serverName, keyId],
		)) as Record<string, unknown>[];
		if (!rows[0]) return undefined;
		return {
			key: rows[0].key as string,
			validUntil: Number(rows[0].valid_until),
		};
	}

	async getAuthChain(eventIds: EventId[]): Promise<PDU[]> {
		const visited = new Set<EventId>();
		const result: PDU[] = [];
		const queue = [...eventIds];

		while (queue.length > 0) {
			const id = queue.shift() as EventId;
			if (visited.has(id)) continue;
			visited.add(id);
			const rows = (await this.query(
				"SELECT event_json FROM events WHERE event_id = ?",
				[id],
			)) as Record<string, unknown>[];
			if (!rows[0]) continue;
			const event = this.parseJson(rows[0].event_json) as PDU;
			result.push(event);
			for (const authId of event.auth_events) {
				if (!visited.has(authId)) queue.push(authId);
			}
		}
		return result;
	}

	async getServersInRoom(roomId: RoomId): Promise<ServerName[]> {
		const rows = (await this.query(
			"SELECT state_key FROM state_events WHERE room_id = ? AND event_type = 'm.room.member' AND JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.content.membership')) = 'join'",
			[roomId],
		)) as Record<string, unknown>[];
		const servers = new Set<ServerName>();
		for (const r of rows) {
			const serverName = (r.state_key as string)
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
		const room = await this.getRoom(_roomId);
		if (!room) return undefined;
		return new Map(room.state_events);
	}

	async getFederationTxn(origin: ServerName, txnId: string): Promise<boolean> {
		const rows = (await this.query(
			"SELECT 1 FROM federation_txns WHERE origin = ? AND txn_id = ?",
			[origin, txnId],
		)) as unknown[];
		return rows.length > 0;
	}

	async setFederationTxn(origin: ServerName, txnId: string): Promise<void> {
		await this.exec(
			"INSERT IGNORE INTO federation_txns (origin, txn_id) VALUES (?, ?)",
			[origin, txnId],
		);
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
		const conn = await this.pool.getConnection();
		try {
			await conn.beginTransaction();
			for (const event of authChain) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				await conn.query(
					"INSERT IGNORE INTO events (event_id, room_id, stream_pos, event_json) VALUES (?, ?, ?, ?)",
					[eventId, event.room_id, this.streamCounter, this.json(event)],
				);
			}

			let maxDepth = 0;
			const extremities: EventId[] = [];
			for (const event of stateEvents) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				await conn.query(
					"INSERT IGNORE INTO events (event_id, room_id, stream_pos, event_json) VALUES (?, ?, ?, ?)",
					[eventId, event.room_id, this.streamCounter, this.json(event)],
				);
				await conn.query(
					`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES (?, ?, ?, ?, ?)
					 ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), event_json = VALUES(event_json)`,
					[
						roomId,
						event.type,
						event.state_key ?? "",
						eventId,
						this.json(event),
					],
				);
				if (event.depth > maxDepth) maxDepth = event.depth;
				extremities.length = 0;
				extremities.push(eventId);
			}

			await conn.query(
				`INSERT INTO rooms (room_id, room_version, depth, forward_extremities) VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE room_version = VALUES(room_version), depth = VALUES(depth), forward_extremities = VALUES(forward_extremities)`,
				[roomId, roomVersion, maxDepth + 1, this.json(extremities)],
			);
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
		this.wakeWaiters();
	}
}
