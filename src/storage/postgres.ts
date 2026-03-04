import pg from "pg";
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
import { EphemeralMixin, INVITE_STATE_TYPES } from "./ephemeral.ts";
import type { Storage, StoredSession } from "./interface.ts";

export class PostgresStorage extends EphemeralMixin implements Storage {
	private pool: pg.Pool;

	private constructor(pool: pg.Pool) {
		super();
		this.pool = pool;
	}

	static async create(connectionString: string): Promise<PostgresStorage> {
		const pool = new pg.Pool({ connectionString, max: 20 });
		const storage = new PostgresStorage(pool);
		await storage.init();
		return storage;
	}

	private async init(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				user_id TEXT PRIMARY KEY,
				localpart TEXT UNIQUE NOT NULL,
				server_name TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				account_type TEXT NOT NULL DEFAULT 'user',
				is_deactivated BOOLEAN NOT NULL DEFAULT FALSE,
				created_at BIGINT NOT NULL,
				displayname TEXT,
				avatar_url TEXT
			);

			CREATE TABLE IF NOT EXISTS sessions (
				access_token TEXT PRIMARY KEY,
				refresh_token TEXT,
				device_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				access_token_hash TEXT,
				expires_at BIGINT,
				display_name TEXT,
				last_seen_ip TEXT,
				last_seen_ts BIGINT,
				user_agent TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
			CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token) WHERE refresh_token IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(user_id, device_id);

			CREATE TABLE IF NOT EXISTS uiaa_sessions (
				session_id TEXT PRIMARY KEY,
				completed JSONB NOT NULL DEFAULT '[]'
			);

			CREATE TABLE IF NOT EXISTS rooms (
				room_id TEXT PRIMARY KEY,
				room_version TEXT NOT NULL,
				depth INT NOT NULL DEFAULT 0,
				forward_extremities JSONB NOT NULL DEFAULT '[]'
			);

			CREATE TABLE IF NOT EXISTS events (
				event_id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				stream_pos BIGINT NOT NULL,
				event_json JSONB NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id);
			CREATE INDEX IF NOT EXISTS idx_events_stream ON events(room_id, stream_pos);

			CREATE TABLE IF NOT EXISTS state_events (
				room_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				state_key TEXT NOT NULL,
				event_id TEXT NOT NULL,
				event_json JSONB NOT NULL,
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
				servers JSONB NOT NULL DEFAULT '[]',
				creator TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS room_directory (
				room_id TEXT PRIMARY KEY,
				visibility TEXT NOT NULL DEFAULT 'private'
			);

			CREATE TABLE IF NOT EXISTS global_account_data (
				user_id TEXT NOT NULL,
				type TEXT NOT NULL,
				content JSONB NOT NULL,
				PRIMARY KEY (user_id, type)
			);

			CREATE TABLE IF NOT EXISTS room_account_data (
				user_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				type TEXT NOT NULL,
				content JSONB NOT NULL,
				PRIMARY KEY (user_id, room_id, type)
			);

			CREATE TABLE IF NOT EXISTS receipts (
				room_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				receipt_type TEXT NOT NULL,
				ts BIGINT NOT NULL,
				PRIMARY KEY (room_id, user_id, receipt_type)
			);

			CREATE TABLE IF NOT EXISTS media (
				origin TEXT NOT NULL,
				media_id TEXT NOT NULL,
				user_id TEXT,
				content_type TEXT NOT NULL,
				upload_name TEXT,
				file_size BIGINT NOT NULL,
				content_hash TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				quarantined BOOLEAN NOT NULL DEFAULT FALSE,
				data BYTEA NOT NULL,
				PRIMARY KEY (origin, media_id)
			);

			CREATE TABLE IF NOT EXISTS filters (
				user_id TEXT NOT NULL,
				filter_id BIGINT NOT NULL,
				filter_json JSONB NOT NULL,
				PRIMARY KEY (user_id, filter_id)
			);

			CREATE TABLE IF NOT EXISTS device_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				keys_json JSONB NOT NULL,
				PRIMARY KEY (user_id, device_id)
			);

			CREATE TABLE IF NOT EXISTS one_time_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				key_id TEXT NOT NULL,
				algorithm TEXT NOT NULL,
				key_json JSONB NOT NULL,
				PRIMARY KEY (user_id, device_id, key_id)
			);

			CREATE TABLE IF NOT EXISTS fallback_keys (
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				key_id TEXT NOT NULL,
				key_json JSONB NOT NULL,
				PRIMARY KEY (user_id, device_id, key_id)
			);

			CREATE TABLE IF NOT EXISTS to_device (
				id BIGSERIAL PRIMARY KEY,
				user_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				event_json JSONB NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_to_device ON to_device(user_id, device_id);

			CREATE TABLE IF NOT EXISTS pushers (
				user_id TEXT NOT NULL,
				app_id TEXT NOT NULL,
				pushkey TEXT NOT NULL,
				pusher_json JSONB NOT NULL,
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
				stream_pos BIGINT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_event_id);

			CREATE TABLE IF NOT EXISTS reports (
				id BIGSERIAL PRIMARY KEY,
				user_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				score INT,
				reason TEXT,
				ts BIGINT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS openid_tokens (
				token TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				expires_at BIGINT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS threepids (
				user_id TEXT NOT NULL,
				medium TEXT NOT NULL,
				address TEXT NOT NULL,
				added_at BIGINT NOT NULL,
				PRIMARY KEY (user_id, medium, address)
			);

			CREATE TABLE IF NOT EXISTS server_keys (
				server_name TEXT NOT NULL,
				key_id TEXT NOT NULL,
				key TEXT NOT NULL,
				valid_until BIGINT NOT NULL,
				PRIMARY KEY (server_name, key_id)
			);

			CREATE TABLE IF NOT EXISTS federation_txns (
				origin TEXT NOT NULL,
				txn_id TEXT NOT NULL,
				PRIMARY KEY (origin, txn_id)
			);
		`);

		const {
			rows: [maxPos],
		} = await this.pool.query<{ m: string | null }>(
			"SELECT MAX(stream_pos) AS m FROM events",
		);
		this.streamCounter = maxPos?.m ? parseInt(maxPos.m, 10) : 0;

		const {
			rows: [maxFilter],
		} = await this.pool.query<{ m: string | null }>(
			"SELECT MAX(filter_id) AS m FROM filters",
		);
		this.filterCounter = maxFilter?.m ? parseInt(maxFilter.m, 10) : 0;
	}

	async createUser(account: UserAccount): Promise<void> {
		await this.pool.query(
			`INSERT INTO users (user_id, localpart, server_name, password_hash, account_type, is_deactivated, created_at, displayname, avatar_url)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (user_id) DO UPDATE SET
				localpart = EXCLUDED.localpart, server_name = EXCLUDED.server_name, password_hash = EXCLUDED.password_hash,
				account_type = EXCLUDED.account_type, is_deactivated = EXCLUDED.is_deactivated, created_at = EXCLUDED.created_at,
				displayname = EXCLUDED.displayname, avatar_url = EXCLUDED.avatar_url`,
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

	private rowToUser(row: Record<string, unknown>): UserAccount {
		const user: UserAccount = {
			user_id: row.user_id as UserId,
			localpart: row.localpart as string,
			server_name: row.server_name as ServerName,
			password_hash: row.password_hash as string,
			account_type: row.account_type as UserAccount["account_type"],
			is_deactivated: row.is_deactivated as boolean,
			created_at: Number(row.created_at),
		};
		if (row.displayname) user.displayname = row.displayname as string;
		if (row.avatar_url) user.avatar_url = row.avatar_url as string;
		return user;
	}

	async getUserByLocalpart(
		localpart: string,
	): Promise<UserAccount | undefined> {
		const { rows } = await this.pool.query(
			"SELECT * FROM users WHERE localpart = $1",
			[localpart],
		);
		return rows[0] ? this.rowToUser(rows[0]) : undefined;
	}

	async getUserById(userId: UserId): Promise<UserAccount | undefined> {
		const { rows } = await this.pool.query(
			"SELECT * FROM users WHERE user_id = $1",
			[userId],
		);
		return rows[0] ? this.rowToUser(rows[0]) : undefined;
	}

	private rowToSession(row: Record<string, unknown>): StoredSession {
		const session: StoredSession = {
			access_token: row.access_token as AccessToken,
			device_id: row.device_id as DeviceId,
			user_id: row.user_id as UserId,
			access_token_hash: row.access_token_hash as string,
		};
		if (row.refresh_token)
			session.refresh_token = row.refresh_token as RefreshToken;
		if (row.expires_at) session.expires_at = Number(row.expires_at);
		if (row.display_name) session.display_name = row.display_name as string;
		if (row.last_seen_ip) session.last_seen_ip = row.last_seen_ip as string;
		if (row.last_seen_ts) session.last_seen_ts = Number(row.last_seen_ts);
		if (row.user_agent) session.user_agent = row.user_agent as string;
		return session;
	}

	async createSession(session: StoredSession): Promise<void> {
		await this.pool.query(
			`INSERT INTO sessions (access_token, refresh_token, device_id, user_id, access_token_hash, expires_at, display_name, last_seen_ip, last_seen_ts, user_agent)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (access_token) DO UPDATE SET
				refresh_token = EXCLUDED.refresh_token, device_id = EXCLUDED.device_id, user_id = EXCLUDED.user_id,
				access_token_hash = EXCLUDED.access_token_hash, expires_at = EXCLUDED.expires_at, display_name = EXCLUDED.display_name,
				last_seen_ip = EXCLUDED.last_seen_ip, last_seen_ts = EXCLUDED.last_seen_ts, user_agent = EXCLUDED.user_agent`,
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
		const { rows } = await this.pool.query(
			"SELECT * FROM sessions WHERE access_token = $1",
			[token],
		);
		return rows[0] ? this.rowToSession(rows[0]) : undefined;
	}

	async getSessionByRefreshToken(
		token: RefreshToken,
	): Promise<StoredSession | undefined> {
		const { rows } = await this.pool.query(
			"SELECT * FROM sessions WHERE refresh_token = $1",
			[token],
		);
		return rows[0] ? this.rowToSession(rows[0]) : undefined;
	}

	async getSessionsByUser(userId: UserId): Promise<StoredSession[]> {
		const { rows } = await this.pool.query(
			"SELECT * FROM sessions WHERE user_id = $1",
			[userId],
		);
		return rows.map((r) => this.rowToSession(r));
	}

	async deleteSession(token: AccessToken): Promise<void> {
		await this.pool.query("DELETE FROM sessions WHERE access_token = $1", [
			token,
		]);
	}

	async deleteAllSessions(userId: UserId): Promise<void> {
		await this.pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
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
		await this.pool.query(
			"UPDATE sessions SET last_seen_ip = $1, last_seen_ts = $2, user_agent = $3 WHERE access_token = $4",
			[ip, Date.now(), userAgent, token],
		);
	}

	async createUIAASession(sessionId: string): Promise<void> {
		await this.pool.query(
			"INSERT INTO uiaa_sessions (session_id, completed) VALUES ($1, '[]'::jsonb) ON CONFLICT (session_id) DO UPDATE SET completed = '[]'::jsonb",
			[sessionId],
		);
	}

	async getUIAASession(
		sessionId: string,
	): Promise<{ completed: string[] } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT completed FROM uiaa_sessions WHERE session_id = $1",
			[sessionId],
		);
		if (!rows[0]) return undefined;
		return { completed: rows[0].completed };
	}

	async addUIAACompleted(sessionId: string, stageType: string): Promise<void> {
		await this.pool.query(
			"UPDATE uiaa_sessions SET completed = completed || $1::jsonb WHERE session_id = $2",
			[JSON.stringify([stageType]), sessionId],
		);
	}

	async deleteUIAASession(sessionId: string): Promise<void> {
		await this.pool.query("DELETE FROM uiaa_sessions WHERE session_id = $1", [
			sessionId,
		]);
	}

	async createRoom(state: RoomState): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO rooms (room_id, room_version, depth, forward_extremities) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (room_id) DO UPDATE SET room_version = EXCLUDED.room_version, depth = EXCLUDED.depth, forward_extremities = EXCLUDED.forward_extremities`,
				[
					state.room_id,
					state.room_version,
					state.depth,
					JSON.stringify(state.forward_extremities),
				],
			);
			for (const [key, event] of state.state_events) {
				const [eventType, stateKey] = key.split("\0") as [string, string];
				const eventId = computeEventId(event);
				await client.query(
					`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (room_id, event_type, state_key) DO UPDATE SET event_id = EXCLUDED.event_id, event_json = EXCLUDED.event_json`,
					[state.room_id, eventType, stateKey, eventId, JSON.stringify(event)],
				);
			}
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK");
			throw e;
		} finally {
			client.release();
		}
		this.roomCache.set(state.room_id, state);
	}

	async getRoom(roomId: RoomId): Promise<RoomState | undefined> {
		const cached = this.roomCache.get(roomId);
		if (cached) return cached;

		const { rows } = await this.pool.query(
			"SELECT * FROM rooms WHERE room_id = $1",
			[roomId],
		);
		if (!rows[0]) return undefined;
		const row = rows[0];

		const { rows: stateRows } = await this.pool.query(
			"SELECT event_type, state_key, event_json FROM state_events WHERE room_id = $1",
			[roomId],
		);
		const stateMap = new Map<string, PDU>();
		for (const sr of stateRows) {
			stateMap.set(`${sr.event_type}\0${sr.state_key}`, sr.event_json);
		}

		const room: RoomState = {
			room_id: row.room_id as RoomId,
			room_version: row.room_version as RoomVersion,
			state_events: stateMap,
			depth: row.depth,
			forward_extremities: row.forward_extremities,
		};
		this.roomCache.set(roomId, room);
		return room;
	}

	async getRoomsForUser(userId: UserId): Promise<RoomId[]> {
		const { rows } = await this.pool.query(
			"SELECT room_id FROM state_events WHERE event_type = 'm.room.member' AND state_key = $1 AND event_json->'content'->>'membership' = 'join'",
			[userId],
		);
		return rows.map((r) => r.room_id as RoomId);
	}

	async storeEvent(event: PDU, eventId: EventId): Promise<void> {
		this.streamCounter++;
		await this.pool.query(
			`INSERT INTO events (event_id, room_id, stream_pos, event_json) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (event_id) DO UPDATE SET room_id = EXCLUDED.room_id, stream_pos = EXCLUDED.stream_pos, event_json = EXCLUDED.event_json`,
			[eventId, event.room_id, this.streamCounter, JSON.stringify(event)],
		);
		this.wakeWaiters();
	}

	async getEvent(
		eventId: EventId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT event_id, event_json FROM events WHERE event_id = $1",
			[eventId],
		);
		if (!rows[0]) return undefined;
		return { event: rows[0].event_json, eventId: rows[0].event_id as EventId };
	}

	async getEventsByRoom(
		roomId: RoomId,
		limit: number,
		from?: number,
		direction: "b" | "f" = "f",
	): Promise<{ events: { event: PDU; eventId: EventId }[]; end?: number }> {
		const fromPos = from ?? (direction === "f" ? 0 : this.streamCounter + 1);
		let rows: { event_id: string; event_json: PDU; stream_pos: string }[];

		if (direction === "f") {
			({ rows } = await this.pool.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = $1 AND stream_pos > $2 ORDER BY stream_pos ASC LIMIT $3",
				[roomId, fromPos, limit],
			));
		} else {
			({ rows } = await this.pool.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = $1 AND stream_pos < $2 ORDER BY stream_pos DESC LIMIT $3",
				[roomId, fromPos, limit],
			));
		}

		const events = rows.map((r) => ({
			event: r.event_json,
			eventId: r.event_id as EventId,
		}));
		const lastRow = rows[rows.length - 1];
		const end = lastRow
			? parseInt(lastRow.stream_pos as string, 10)
			: undefined;
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
		const { rows } = await this.pool.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = $1 AND event_type = $2 AND state_key = $3",
			[roomId, eventType, stateKey],
		);
		if (!rows[0]) return undefined;
		return { event: rows[0].event_json, eventId: rows[0].event_id as EventId };
	}

	async getAllState(
		roomId: RoomId,
	): Promise<{ event: PDU; eventId: EventId }[]> {
		const { rows } = await this.pool.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = $1",
			[roomId],
		);
		return rows.map((r) => ({
			event: r.event_json,
			eventId: r.event_id as EventId,
		}));
	}

	async setStateEvent(
		roomId: RoomId,
		event: PDU,
		eventId: EventId,
	): Promise<void> {
		await this.pool.query(
			`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (room_id, event_type, state_key) DO UPDATE SET event_id = EXCLUDED.event_id, event_json = EXCLUDED.event_json`,
			[
				roomId,
				event.type,
				event.state_key ?? "",
				eventId,
				JSON.stringify(event),
			],
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
		const { rows } = await this.pool.query(
			"SELECT event_id, event_json FROM state_events WHERE room_id = $1 AND event_type = 'm.room.member'",
			[roomId],
		);
		return rows.map((r) => ({
			event: r.event_json,
			eventId: r.event_id as EventId,
		}));
	}

	async getTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
	): Promise<EventId | undefined> {
		const { rows } = await this.pool.query(
			"SELECT event_id FROM txn_map WHERE user_id = $1 AND device_id = $2 AND txn_id = $3",
			[userId, deviceId, txnId],
		);
		return rows[0] ? (rows[0].event_id as EventId) : undefined;
	}

	async setTxnEventId(
		userId: UserId,
		deviceId: DeviceId,
		txnId: string,
		eventId: EventId,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO txn_map (user_id, device_id, txn_id, event_id) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, device_id, txn_id) DO UPDATE SET event_id = EXCLUDED.event_id",
			[userId, deviceId, txnId, eventId],
		);
	}

	async getRoomsForUserWithMembership(
		userId: UserId,
	): Promise<{ roomId: RoomId; membership: string }[]> {
		const { rows } = await this.pool.query(
			"SELECT room_id, event_json->'content'->>'membership' AS membership FROM state_events WHERE event_type = 'm.room.member' AND state_key = $1",
			[userId],
		);
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
		const {
			rows: [countRow],
		} = await this.pool.query(
			"SELECT COUNT(*) AS cnt FROM events WHERE room_id = $1 AND stream_pos > $2",
			[roomId, since],
		);
		const total = parseInt(countRow.cnt, 10);
		const limited = total > limit;

		let rows: { event_id: string; event_json: PDU; stream_pos: string }[];
		if (limited) {
			({ rows } = await this.pool.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = $1 AND stream_pos > $2 ORDER BY stream_pos DESC LIMIT $3",
				[roomId, since, limit],
			));
			rows.reverse();
		} else {
			({ rows } = await this.pool.query(
				"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = $1 AND stream_pos > $2 ORDER BY stream_pos ASC",
				[roomId, since],
			));
		}

		const events = rows.map((r) => ({
			event: r.event_json,
			eventId: r.event_id as EventId,
			streamPos: parseInt(r.stream_pos as string, 10),
		}));
		return { events, limited };
	}

	async getStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]> {
		const { rows } = await this.pool.query(
			"SELECT event_json FROM state_events WHERE room_id = $1 AND event_type = ANY($2)",
			[roomId, INVITE_STATE_TYPES],
		);
		return rows.map((r) => {
			const event = r.event_json as PDU;
			return {
				content: event.content,
				sender: event.sender,
				state_key: event.state_key ?? "",
				type: event.type,
			};
		});
	}

	async getProfile(userId: UserId): Promise<UserProfile | undefined> {
		const { rows } = await this.pool.query(
			"SELECT displayname, avatar_url FROM users WHERE user_id = $1",
			[userId],
		);
		if (!rows[0]) return undefined;
		const profile: UserProfile = {};
		if (rows[0].displayname) profile.displayname = rows[0].displayname;
		if (rows[0].avatar_url) profile.avatar_url = rows[0].avatar_url;
		return profile;
	}

	async setDisplayName(
		userId: UserId,
		displayname: string | null,
	): Promise<void> {
		await this.pool.query(
			"UPDATE users SET displayname = $1 WHERE user_id = $2",
			[displayname, userId],
		);
	}

	async setAvatarUrl(userId: UserId, avatarUrl: string | null): Promise<void> {
		await this.pool.query(
			"UPDATE users SET avatar_url = $1 WHERE user_id = $2",
			[avatarUrl, userId],
		);
	}

	async getDevice(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Device | undefined> {
		const { rows } = await this.pool.query(
			"SELECT device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = $1 AND device_id = $2 LIMIT 1",
			[userId, deviceId],
		);
		if (!rows[0]) return undefined;
		return {
			device_id: rows[0].device_id as DeviceId,
			display_name: rows[0].display_name ?? undefined,
			last_seen_ip: rows[0].last_seen_ip ?? undefined,
			last_seen_ts: rows[0].last_seen_ts
				? Number(rows[0].last_seen_ts)
				: undefined,
		};
	}

	async getAllDevices(userId: UserId): Promise<Device[]> {
		const { rows } = await this.pool.query(
			"SELECT DISTINCT ON (device_id) device_id, display_name, last_seen_ip, last_seen_ts FROM sessions WHERE user_id = $1",
			[userId],
		);
		return rows.map((r) => ({
			device_id: r.device_id as DeviceId,
			display_name: r.display_name ?? undefined,
			last_seen_ip: r.last_seen_ip ?? undefined,
			last_seen_ts: r.last_seen_ts ? Number(r.last_seen_ts) : undefined,
		}));
	}

	async updateDeviceDisplayName(
		userId: UserId,
		deviceId: DeviceId,
		displayName: string,
	): Promise<void> {
		await this.pool.query(
			"UPDATE sessions SET display_name = $1 WHERE user_id = $2 AND device_id = $3",
			[displayName, userId, deviceId],
		);
	}

	async deleteDeviceSession(userId: UserId, deviceId: DeviceId): Promise<void> {
		await this.pool.query(
			"DELETE FROM sessions WHERE user_id = $1 AND device_id = $2",
			[userId, deviceId],
		);
	}

	async updatePassword(userId: UserId, newPasswordHash: string): Promise<void> {
		await this.pool.query(
			"UPDATE users SET password_hash = $1 WHERE user_id = $2",
			[newPasswordHash, userId],
		);
	}

	async deactivateUser(userId: UserId): Promise<void> {
		await this.pool.query(
			"UPDATE users SET is_deactivated = TRUE WHERE user_id = $1",
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
		await this.pool.query(
			"INSERT INTO room_aliases (room_alias, room_id, servers, creator) VALUES ($1, $2, $3, $4) ON CONFLICT (room_alias) DO UPDATE SET room_id = EXCLUDED.room_id, servers = EXCLUDED.servers, creator = EXCLUDED.creator",
			[roomAlias, roomId, JSON.stringify(servers), creator],
		);
	}

	async deleteRoomAlias(roomAlias: RoomAlias): Promise<boolean> {
		const result = await this.pool.query(
			"DELETE FROM room_aliases WHERE room_alias = $1",
			[roomAlias],
		);
		return (result.rowCount ?? 0) > 0;
	}

	async getRoomByAlias(
		roomAlias: RoomAlias,
	): Promise<{ room_id: RoomId; servers: ServerName[] } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT room_id, servers FROM room_aliases WHERE room_alias = $1",
			[roomAlias],
		);
		if (!rows[0]) return undefined;
		return { room_id: rows[0].room_id as RoomId, servers: rows[0].servers };
	}

	async getAliasesForRoom(roomId: RoomId): Promise<RoomAlias[]> {
		const { rows } = await this.pool.query(
			"SELECT room_alias FROM room_aliases WHERE room_id = $1",
			[roomId],
		);
		return rows.map((r) => r.room_alias as RoomAlias);
	}

	async getAliasCreator(roomAlias: RoomAlias): Promise<UserId | undefined> {
		const { rows } = await this.pool.query(
			"SELECT creator FROM room_aliases WHERE room_alias = $1",
			[roomAlias],
		);
		return rows[0] ? (rows[0].creator as UserId) : undefined;
	}

	async setRoomVisibility(
		roomId: RoomId,
		visibility: "public" | "private",
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO room_directory (room_id, visibility) VALUES ($1, $2) ON CONFLICT (room_id) DO UPDATE SET visibility = EXCLUDED.visibility",
			[roomId, visibility],
		);
	}

	async getRoomVisibility(roomId: RoomId): Promise<"public" | "private"> {
		const { rows } = await this.pool.query(
			"SELECT visibility FROM room_directory WHERE room_id = $1",
			[roomId],
		);
		return (rows[0]?.visibility as "public" | "private") ?? "private";
	}

	async getPublicRoomIds(): Promise<RoomId[]> {
		const { rows } = await this.pool.query(
			"SELECT room_id FROM room_directory WHERE visibility = 'public'",
		);
		return rows.map((r) => r.room_id as RoomId);
	}

	async getGlobalAccountData(
		userId: UserId,
		type: string,
	): Promise<JsonObject | undefined> {
		const { rows } = await this.pool.query(
			"SELECT content FROM global_account_data WHERE user_id = $1 AND type = $2",
			[userId, type],
		);
		return rows[0]?.content ?? undefined;
	}

	async setGlobalAccountData(
		userId: UserId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO global_account_data (user_id, type, content) VALUES ($1, $2, $3) ON CONFLICT (user_id, type) DO UPDATE SET content = EXCLUDED.content",
			[userId, type, JSON.stringify(content)],
		);
	}

	async getAllGlobalAccountData(
		userId: UserId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const { rows } = await this.pool.query(
			"SELECT type, content FROM global_account_data WHERE user_id = $1",
			[userId],
		);
		return rows.map((r) => ({ type: r.type, content: r.content }));
	}

	async getRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
	): Promise<JsonObject | undefined> {
		const { rows } = await this.pool.query(
			"SELECT content FROM room_account_data WHERE user_id = $1 AND room_id = $2 AND type = $3",
			[userId, roomId, type],
		);
		return rows[0]?.content ?? undefined;
	}

	async setRoomAccountData(
		userId: UserId,
		roomId: RoomId,
		type: string,
		content: JsonObject,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO room_account_data (user_id, room_id, type, content) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, room_id, type) DO UPDATE SET content = EXCLUDED.content",
			[userId, roomId, type, JSON.stringify(content)],
		);
	}

	async getAllRoomAccountData(
		userId: UserId,
		roomId: RoomId,
	): Promise<{ type: string; content: JsonObject }[]> {
		const { rows } = await this.pool.query(
			"SELECT type, content FROM room_account_data WHERE user_id = $1 AND room_id = $2",
			[userId, roomId],
		);
		return rows.map((r) => ({ type: r.type, content: r.content }));
	}

	async setReceipt(
		roomId: RoomId,
		userId: UserId,
		eventId: EventId,
		receiptType: string,
		ts: Timestamp,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO receipts (room_id, user_id, event_id, receipt_type, ts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (room_id, user_id, receipt_type) DO UPDATE SET event_id = EXCLUDED.event_id, ts = EXCLUDED.ts",
			[roomId, userId, eventId, receiptType, ts],
		);
		this.wakeWaiters();
	}

	async getReceipts(
		roomId: RoomId,
	): Promise<
		{ eventId: EventId; receiptType: string; userId: UserId; ts: Timestamp }[]
	> {
		const { rows } = await this.pool.query(
			"SELECT event_id, receipt_type, user_id, ts FROM receipts WHERE room_id = $1",
			[roomId],
		);
		return rows.map((r) => ({
			eventId: r.event_id as EventId,
			receiptType: r.receipt_type,
			userId: r.user_id as UserId,
			ts: Number(r.ts),
		}));
	}

	async storeMedia(media: StoredMedia, data: Buffer): Promise<void> {
		await this.pool.query(
			`INSERT INTO media (origin, media_id, user_id, content_type, upload_name, file_size, content_hash, created_at, quarantined, data)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (origin, media_id) DO UPDATE SET user_id = EXCLUDED.user_id, content_type = EXCLUDED.content_type, upload_name = EXCLUDED.upload_name,
				file_size = EXCLUDED.file_size, content_hash = EXCLUDED.content_hash, created_at = EXCLUDED.created_at, quarantined = EXCLUDED.quarantined, data = EXCLUDED.data`,
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
		const { rows } = await this.pool.query(
			"SELECT * FROM media WHERE origin = $1 AND media_id = $2",
			[serverName, mediaId],
		);
		if (!rows[0]) return undefined;
		const row = rows[0];
		return {
			metadata: {
				media_id: row.media_id,
				origin: row.origin as ServerName,
				user_id: row.user_id ?? undefined,
				content_type: row.content_type,
				upload_name: row.upload_name ?? undefined,
				file_size: Number(row.file_size),
				content_hash: row.content_hash,
				created_at: Number(row.created_at),
				quarantined: row.quarantined,
			},
			data: row.data,
		};
	}

	async createFilter(userId: UserId, filter: JsonObject): Promise<string> {
		const filterId = String(++this.filterCounter);
		await this.pool.query(
			"INSERT INTO filters (user_id, filter_id, filter_json) VALUES ($1, $2, $3) ON CONFLICT (user_id, filter_id) DO UPDATE SET filter_json = EXCLUDED.filter_json",
			[userId, filterId, JSON.stringify(filter)],
		);
		return filterId;
	}

	async getFilter(
		userId: UserId,
		filterId: string,
	): Promise<JsonObject | undefined> {
		const { rows } = await this.pool.query(
			"SELECT filter_json FROM filters WHERE user_id = $1 AND filter_id = $2",
			[userId, filterId],
		);
		return rows[0]?.filter_json ?? undefined;
	}

	async setDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: DeviceKeys,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO device_keys (user_id, device_id, keys_json) VALUES ($1, $2, $3) ON CONFLICT (user_id, device_id) DO UPDATE SET keys_json = EXCLUDED.keys_json",
			[userId, deviceId, JSON.stringify(keys)],
		);
	}

	async getDeviceKeys(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<DeviceKeys | undefined> {
		const { rows } = await this.pool.query(
			"SELECT keys_json FROM device_keys WHERE user_id = $1 AND device_id = $2",
			[userId, deviceId],
		);
		return rows[0]?.keys_json ?? undefined;
	}

	async getAllDeviceKeys(
		userId: UserId,
	): Promise<Record<DeviceId, DeviceKeys>> {
		const { rows } = await this.pool.query(
			"SELECT device_id, keys_json FROM device_keys WHERE user_id = $1",
			[userId],
		);
		const result: Record<DeviceId, DeviceKeys> = {};
		for (const r of rows) result[r.device_id as DeviceId] = r.keys_json;
		return result;
	}

	async addOneTimeKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (const [keyId, key] of Object.entries(keys)) {
				const algorithm = keyId.split(":")[0] as string;
				await client.query(
					"INSERT INTO one_time_keys (user_id, device_id, key_id, algorithm, key_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, device_id, key_id) DO UPDATE SET key_json = EXCLUDED.key_json",
					[userId, deviceId, keyId, algorithm, JSON.stringify(key)],
				);
			}
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK");
			throw e;
		} finally {
			client.release();
		}
	}

	async claimOneTimeKey(
		userId: UserId,
		deviceId: DeviceId,
		algorithm: string,
	): Promise<{ keyId: KeyId; key: string | OneTimeKey } | undefined> {
		const { rows } = await this.pool.query(
			"DELETE FROM one_time_keys WHERE ctid = (SELECT ctid FROM one_time_keys WHERE user_id = $1 AND device_id = $2 AND algorithm = $3 LIMIT 1) RETURNING key_id, key_json",
			[userId, deviceId, algorithm],
		);
		if (rows[0])
			return { keyId: rows[0].key_id as KeyId, key: rows[0].key_json };

		const { rows: fallbackRows } = await this.pool.query(
			"SELECT key_id, key_json FROM fallback_keys WHERE user_id = $1 AND device_id = $2 AND key_id LIKE $3 LIMIT 1",
			[userId, deviceId, `${algorithm}:%`],
		);
		if (fallbackRows[0])
			return {
				keyId: fallbackRows[0].key_id as KeyId,
				key: fallbackRows[0].key_json,
			};
		return undefined;
	}

	async getOneTimeKeyCounts(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<Record<string, number>> {
		const { rows } = await this.pool.query(
			"SELECT algorithm, COUNT(*)::int AS cnt FROM one_time_keys WHERE user_id = $1 AND device_id = $2 GROUP BY algorithm",
			[userId, deviceId],
		);
		const counts: Record<string, number> = {};
		for (const r of rows) counts[r.algorithm] = r.cnt;
		return counts;
	}

	async setFallbackKeys(
		userId: UserId,
		deviceId: DeviceId,
		keys: Record<KeyId, string | OneTimeKey>,
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"DELETE FROM fallback_keys WHERE user_id = $1 AND device_id = $2",
				[userId, deviceId],
			);
			for (const [keyId, key] of Object.entries(keys)) {
				await client.query(
					"INSERT INTO fallback_keys (user_id, device_id, key_id, key_json) VALUES ($1, $2, $3, $4)",
					[userId, deviceId, keyId, JSON.stringify(key)],
				);
			}
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK");
			throw e;
		} finally {
			client.release();
		}
	}

	async getFallbackKeyTypes(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<string[]> {
		const { rows } = await this.pool.query(
			"SELECT DISTINCT key_id FROM fallback_keys WHERE user_id = $1 AND device_id = $2",
			[userId, deviceId],
		);
		const types = new Set<string>();
		for (const r of rows) types.add(r.key_id.split(":")[0] as string);
		return [...types];
	}

	async sendToDevice(
		userId: UserId,
		deviceId: DeviceId,
		event: ToDeviceEvent,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO to_device (user_id, device_id, event_json) VALUES ($1, $2, $3)",
			[userId, deviceId, JSON.stringify(event)],
		);
		this.wakeWaiters();
	}

	async getToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<ToDeviceEvent[]> {
		const { rows } = await this.pool.query(
			"SELECT event_json FROM to_device WHERE user_id = $1 AND device_id = $2 ORDER BY id",
			[userId, deviceId],
		);
		return rows.map((r) => r.event_json);
	}

	async clearToDeviceMessages(
		userId: UserId,
		deviceId: DeviceId,
	): Promise<void> {
		await this.pool.query(
			"DELETE FROM to_device WHERE user_id = $1 AND device_id = $2",
			[userId, deviceId],
		);
	}

	async getPushers(userId: UserId): Promise<Pusher[]> {
		const { rows } = await this.pool.query(
			"SELECT pusher_json FROM pushers WHERE user_id = $1",
			[userId],
		);
		return rows.map((r) => r.pusher_json);
	}

	async setPusher(userId: UserId, pusher: Pusher): Promise<void> {
		await this.pool.query(
			"INSERT INTO pushers (user_id, app_id, pushkey, pusher_json) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, app_id, pushkey) DO UPDATE SET pusher_json = EXCLUDED.pusher_json",
			[userId, pusher.app_id, pusher.pushkey, JSON.stringify(pusher)],
		);
	}

	async deletePusher(
		userId: UserId,
		appId: string,
		pushkey: string,
	): Promise<void> {
		await this.pool.query(
			"DELETE FROM pushers WHERE user_id = $1 AND app_id = $2 AND pushkey = $3",
			[userId, appId, pushkey],
		);
	}

	async deletePusherByKey(appId: string, pushkey: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM pushers WHERE app_id = $1 AND pushkey = $2",
			[appId, pushkey],
		);
	}

	async storeRelation(
		eventId: EventId,
		roomId: RoomId,
		relType: string,
		targetEventId: EventId,
		key?: string,
	): Promise<void> {
		const { rows } = await this.pool.query(
			"SELECT event_json, stream_pos FROM events WHERE event_id = $1",
			[eventId],
		);
		if (!rows[0]) return;
		const event = rows[0].event_json as PDU;
		const streamPos = parseInt(rows[0].stream_pos, 10);
		await this.pool.query(
			"INSERT INTO relations (event_id, room_id, rel_type, target_event_id, key, sender, event_type, stream_pos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
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
			"SELECT r.event_id, r.stream_pos, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = $1 AND r.room_id = $2";
		const params: unknown[] = [eventId, roomId];
		let paramIdx = 3;

		if (relType) {
			sql += ` AND r.rel_type = $${paramIdx++}`;
			params.push(relType);
		}
		if (eventType) {
			sql += ` AND r.event_type = $${paramIdx++}`;
			params.push(eventType);
		}

		const fromPos = from ? parseInt(from, 10) : undefined;
		if (fromPos !== undefined) {
			sql +=
				direction === "f"
					? ` AND r.stream_pos > $${paramIdx++}`
					: ` AND r.stream_pos < $${paramIdx++}`;
			params.push(fromPos);
		}

		sql +=
			direction === "f"
				? ` ORDER BY r.stream_pos ASC LIMIT $${paramIdx}`
				: ` ORDER BY r.stream_pos DESC LIMIT $${paramIdx}`;
		params.push(limit);

		const { rows } = await this.pool.query(sql, params);
		const events = rows.map((r: Record<string, unknown>) => ({
			event: r.event_json as PDU,
			eventId: r.event_id as EventId,
		}));
		const nextBatch =
			rows.length === limit && rows.length > 0
				? String((rows[rows.length - 1] as Record<string, unknown>).stream_pos)
				: undefined;
		return { events, nextBatch };
	}

	async getAnnotationCounts(
		eventId: EventId,
	): Promise<{ type: string; key: string; count: number }[]> {
		const { rows } = await this.pool.query(
			"SELECT event_type, key, COUNT(*)::int AS cnt FROM relations WHERE target_event_id = $1 AND rel_type = 'm.annotation' AND key IS NOT NULL GROUP BY event_type, key",
			[eventId],
		);
		return rows.map((r) => ({ type: r.event_type, key: r.key, count: r.cnt }));
	}

	async getLatestEdit(
		eventId: EventId,
		sender: UserId,
	): Promise<{ event: PDU; eventId: EventId } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = $1 AND r.rel_type = 'm.replace' AND r.sender = $2 ORDER BY r.stream_pos DESC LIMIT 1",
			[eventId, sender],
		);
		if (!rows[0]) return undefined;
		return { event: rows[0].event_json, eventId: rows[0].event_id as EventId };
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
		const {
			rows: [countRow],
		} = await this.pool.query(
			"SELECT COUNT(*)::int AS cnt FROM relations WHERE target_event_id = $1 AND rel_type = 'm.thread'",
			[eventId],
		);
		if (countRow.cnt === 0) return undefined;

		const {
			rows: [latestRow],
		} = await this.pool.query(
			"SELECT r.event_id, e.event_json FROM relations r JOIN events e ON r.event_id = e.event_id WHERE r.target_event_id = $1 AND r.rel_type = 'm.thread' ORDER BY r.stream_pos DESC LIMIT 1",
			[eventId],
		);
		if (!latestRow) return undefined;

		const {
			rows: [participated],
		} = await this.pool.query(
			"SELECT 1 FROM relations WHERE target_event_id = $1 AND rel_type = 'm.thread' AND sender = $2 LIMIT 1",
			[eventId, userId],
		);

		return {
			latestEvent: {
				event: latestRow.event_json,
				eventId: latestRow.event_id as EventId,
			},
			count: countRow.cnt,
			currentUserParticipated: !!participated,
		};
	}

	async storeReport(
		userId: UserId,
		roomId: RoomId,
		eventId: EventId,
		score?: number,
		reason?: string,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO reports (user_id, room_id, event_id, score, reason, ts) VALUES ($1, $2, $3, $4, $5, $6)",
			[userId, roomId, eventId, score ?? null, reason ?? null, Date.now()],
		);
	}

	async storeOpenIdToken(
		token: string,
		userId: UserId,
		expiresAt: Timestamp,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO openid_tokens (token, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at",
			[token, userId, expiresAt],
		);
	}

	async getOpenIdToken(
		token: string,
	): Promise<{ userId: UserId; expiresAt: Timestamp } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT user_id, expires_at FROM openid_tokens WHERE token = $1",
			[token],
		);
		if (!rows[0]) return undefined;
		return {
			userId: rows[0].user_id as UserId,
			expiresAt: Number(rows[0].expires_at),
		};
	}

	async getThreePids(
		userId: UserId,
	): Promise<{ medium: string; address: string; added_at: Timestamp }[]> {
		const { rows } = await this.pool.query(
			"SELECT medium, address, added_at FROM threepids WHERE user_id = $1",
			[userId],
		);
		return rows.map((r) => ({
			medium: r.medium,
			address: r.address,
			added_at: Number(r.added_at),
		}));
	}

	async addThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO threepids (user_id, medium, address, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
			[userId, medium, address, Date.now()],
		);
	}

	async deleteThreePid(
		userId: UserId,
		medium: string,
		address: string,
	): Promise<void> {
		await this.pool.query(
			"DELETE FROM threepids WHERE user_id = $1 AND medium = $2 AND address = $3",
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
		const { rows } = await this.pool.query(
			"SELECT user_id, displayname, avatar_url FROM users WHERE is_deactivated = FALSE AND (user_id ILIKE $1 OR displayname ILIKE $1) LIMIT $2",
			[term, limit],
		);
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
			SELECT r.target_event_id, MAX(r.stream_pos) AS latest_pos, e.event_json
			FROM relations r
			JOIN events e ON r.target_event_id = e.event_id
			WHERE r.rel_type = 'm.thread' AND r.room_id = $1
		`;
		const params: unknown[] = [roomId];
		let paramIdx = 2;

		if (include === "participated") {
			sql += ` AND r.target_event_id IN (SELECT target_event_id FROM relations WHERE rel_type = 'm.thread' AND sender = $${paramIdx++})`;
			params.push(userId);
		}
		if (from) {
			sql += ` AND r.stream_pos < $${paramIdx++}`;
			params.push(parseInt(from, 10));
		}
		sql += ` GROUP BY r.target_event_id, e.event_json ORDER BY latest_pos DESC LIMIT $${paramIdx}`;
		params.push(limit);

		const { rows } = await this.pool.query(sql, params);
		const events = rows.map((r: Record<string, unknown>) => ({
			event: r.event_json as PDU,
			eventId: r.target_event_id as EventId,
		}));
		const nextBatch =
			rows.length === limit && rows.length > 0
				? String((rows[rows.length - 1] as Record<string, unknown>).latest_pos)
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

		let sql =
			"SELECT event_id, event_json, stream_pos FROM events WHERE room_id = ANY($1)";
		const params: unknown[] = [roomIds];
		let paramIdx = 2;

		if (from) {
			sql += ` AND stream_pos < $${paramIdx++}`;
			params.push(parseInt(from, 10));
		}
		sql += " ORDER BY stream_pos DESC";

		const { rows } = await this.pool.query(sql, params);
		const term = searchTerm.toLowerCase();
		const results: { event: PDU; eventId: EventId; streamPos: number }[] = [];

		for (const row of rows) {
			if (results.length >= limit) break;
			const event = row.event_json as PDU;
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
					streamPos: parseInt(row.stream_pos, 10),
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
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (const [keyId, val] of Object.entries(keys.verify_keys)) {
				await client.query(
					"INSERT INTO server_keys (server_name, key_id, key, valid_until) VALUES ($1, $2, $3, $4) ON CONFLICT (server_name, key_id) DO UPDATE SET key = EXCLUDED.key, valid_until = EXCLUDED.valid_until",
					[serverName, keyId, val.key, keys.valid_until_ts],
				);
			}
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK");
			throw e;
		} finally {
			client.release();
		}
	}

	async getServerKeys(
		serverName: ServerName,
		keyId: KeyId,
	): Promise<{ key: string; validUntil: number } | undefined> {
		const { rows } = await this.pool.query(
			"SELECT key, valid_until FROM server_keys WHERE server_name = $1 AND key_id = $2",
			[serverName, keyId],
		);
		if (!rows[0]) return undefined;
		return { key: rows[0].key, validUntil: Number(rows[0].valid_until) };
	}

	async getAuthChain(eventIds: EventId[]): Promise<PDU[]> {
		const visited = new Set<EventId>();
		const result: PDU[] = [];
		const queue = [...eventIds];

		while (queue.length > 0) {
			const id = queue.shift() as EventId;
			if (visited.has(id)) continue;
			visited.add(id);
			const { rows } = await this.pool.query(
				"SELECT event_json FROM events WHERE event_id = $1",
				[id],
			);
			if (!rows[0]) continue;
			const event = rows[0].event_json as PDU;
			result.push(event);
			for (const authId of event.auth_events) {
				if (!visited.has(authId)) queue.push(authId);
			}
		}
		return result;
	}

	async getServersInRoom(roomId: RoomId): Promise<ServerName[]> {
		const { rows } = await this.pool.query(
			"SELECT state_key FROM state_events WHERE room_id = $1 AND event_type = 'm.room.member' AND event_json->'content'->>'membership' = 'join'",
			[roomId],
		);
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
		const room = await this.getRoom(_roomId);
		if (!room) return undefined;
		return new Map(room.state_events);
	}

	async getFederationTxn(origin: ServerName, txnId: string): Promise<boolean> {
		const { rows } = await this.pool.query(
			"SELECT 1 FROM federation_txns WHERE origin = $1 AND txn_id = $2",
			[origin, txnId],
		);
		return rows.length > 0;
	}

	async setFederationTxn(origin: ServerName, txnId: string): Promise<void> {
		await this.pool.query(
			"INSERT INTO federation_txns (origin, txn_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			[origin, txnId],
		);
	}

	async importRoomState(
		roomId: RoomId,
		roomVersion: RoomVersion,
		stateEvents: PDU[],
		authChain: PDU[],
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (const event of authChain) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				await client.query(
					"INSERT INTO events (event_id, room_id, stream_pos, event_json) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING",
					[eventId, event.room_id, this.streamCounter, JSON.stringify(event)],
				);
			}

			let maxDepth = 0;
			const extremities: EventId[] = [];
			for (const event of stateEvents) {
				const eventId = computeEventId(event);
				this.streamCounter++;
				await client.query(
					"INSERT INTO events (event_id, room_id, stream_pos, event_json) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING",
					[eventId, event.room_id, this.streamCounter, JSON.stringify(event)],
				);
				await client.query(
					`INSERT INTO state_events (room_id, event_type, state_key, event_id, event_json) VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (room_id, event_type, state_key) DO UPDATE SET event_id = EXCLUDED.event_id, event_json = EXCLUDED.event_json`,
					[
						roomId,
						event.type,
						event.state_key ?? "",
						eventId,
						JSON.stringify(event),
					],
				);
				if (event.depth > maxDepth) maxDepth = event.depth;
				extremities.length = 0;
				extremities.push(eventId);
			}

			await client.query(
				`INSERT INTO rooms (room_id, room_version, depth, forward_extremities) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (room_id) DO UPDATE SET room_version = EXCLUDED.room_version, depth = EXCLUDED.depth, forward_extremities = EXCLUDED.forward_extremities`,
				[roomId, roomVersion, maxDepth + 1, JSON.stringify(extremities)],
			);
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK");
			throw e;
		} finally {
			client.release();
		}
		this.wakeWaiters();
	}
}
