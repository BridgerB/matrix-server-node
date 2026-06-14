import type { CrossSigningKey, KeyBackupData } from "../types/e2ee.ts";
import type {
	AccessToken,
	DeviceId,
	RefreshToken,
	RoomId,
	ServerName,
	UserAccount,
	UserId,
} from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";
import type { StoredSession } from "./interface.ts";

export interface CrossSigningKeys {
	master_key?: CrossSigningKey;
	self_signing_key?: CrossSigningKey;
	user_signing_key?: CrossSigningKey;
}

/**
 * Assemble a user's cross-signing keys from `cross_signing_keys` rows. `parse`
 * is the backend's JSON decoder (sqlite/mysql parse a string column, postgres
 * may already hand back a JSONB object).
 */
export const rowsToCrossSigningKeys = (
	rows: Record<string, unknown>[],
	parse: (json: unknown) => CrossSigningKey,
): CrossSigningKeys => {
	const result: CrossSigningKeys = {};
	for (const r of rows) {
		if (r.key_type === "master_key") result.master_key = parse(r.key_json);
		else if (r.key_type === "self_signing_key")
			result.self_signing_key = parse(r.key_json);
		else if (r.key_type === "user_signing_key")
			result.user_signing_key = parse(r.key_json);
	}
	return result;
};

export const rowToStoredMedia = (
	row: Record<string, unknown>,
	booleanAsInt = false,
): StoredMedia => ({
	media_id: row.media_id as string,
	origin: row.origin as ServerName,
	user_id: (row.user_id as UserId) ?? undefined,
	content_type: row.content_type as string,
	upload_name: (row.upload_name as string) ?? undefined,
	file_size: Number(row.file_size),
	content_hash: row.content_hash as string,
	created_at: Number(row.created_at),
	quarantined: booleanAsInt ? row.quarantined === 1 : Boolean(row.quarantined),
});

/**
 * Flatten the three shapes accepted by PUT key backup keys (a single session, a
 * room's sessions, or all rooms) into a list of [roomId, sessionId, data] tuples.
 */
export const flattenKeyBackupEntries = (
	roomId: RoomId | undefined,
	sessionId: string | undefined,
	keys:
		| KeyBackupData
		| { sessions: Record<string, KeyBackupData> }
		| { rooms: Record<RoomId, { sessions: Record<string, KeyBackupData> }> },
): [RoomId, string, KeyBackupData][] => {
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
			rooms: Record<RoomId, { sessions: Record<string, KeyBackupData> }>;
		};
		for (const [rid, roomData] of Object.entries(allKeys.rooms)) {
			for (const [sid, data] of Object.entries(roomData.sessions)) {
				entries.push([rid as RoomId, sid, data]);
			}
		}
	}
	return entries;
};

/**
 * Content-derived etag for a key backup: a hash over every (room_id, session_id)
 * pair, so the etag changes whenever a session is added, removed or replaced.
 * Returns "0" for an empty backup.
 */
export const keyBackupEtag = (rows: Record<string, unknown>[]): string => {
	if (rows.length === 0) return "0";
	let hash = 0;
	for (const r of rows) {
		for (const c of `${r.room_id}${r.session_id}`) {
			hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
		}
	}
	return String(Math.abs(hash));
};

/** Pack a partial-state device-list poke (a user/device pair) for set storage. */
export const encodeDevicePoke = (userId: string, deviceId: string): string =>
	`${userId}\x1f${deviceId}`;

/** Unpack a device-list poke produced by {@link encodeDevicePoke}. */
export const decodeDevicePoke = (
	s: string,
): { userId: UserId; deviceId: DeviceId } => {
	const sep = s.indexOf("\x1f");
	return {
		userId: s.slice(0, sep) as UserId,
		deviceId: s.slice(sep + 1) as DeviceId,
	};
};

/**
 * Key-backup merge priority: a newly-uploaded session replaces the stored one
 * iff it is verified and the old one was not, or (same verification) has a lower
 * first_message_index, or (same again) a lower forwarded_count.
 */
export const shouldReplaceBackupKey = (
	next: {
		is_verified: boolean;
		first_message_index: number;
		forwarded_count: number;
	},
	prev: {
		is_verified: boolean;
		first_message_index: number;
		forwarded_count: number;
	},
): boolean =>
	(next.is_verified && !prev.is_verified) ||
	(next.is_verified === prev.is_verified &&
		next.first_message_index < prev.first_message_index) ||
	(next.is_verified === prev.is_verified &&
		next.first_message_index === prev.first_message_index &&
		next.forwarded_count < prev.forwarded_count);

export const rowToUser = (
	row: Record<string, unknown>,
	booleanAsInt = false,
): UserAccount => {
	const user: UserAccount = {
		user_id: row.user_id as UserId,
		localpart: row.localpart as string,
		server_name: row.server_name as ServerName,
		password_hash: row.password_hash as string,
		account_type: row.account_type as UserAccount["account_type"],
		is_deactivated: booleanAsInt
			? row.is_deactivated === 1
			: Boolean(row.is_deactivated),
		created_at: Number(row.created_at),
	};
	if (row.displayname) user.displayname = row.displayname as string;
	if (row.avatar_url) user.avatar_url = row.avatar_url as string;
	return user;
};

export const rowToSession = (row: Record<string, unknown>): StoredSession => {
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
};
