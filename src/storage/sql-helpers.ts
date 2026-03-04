import type {
	AccessToken,
	DeviceId,
	RefreshToken,
	ServerName,
	UserAccount,
	UserId,
} from "../types/index.ts";
import type { StoredSession } from "./interface.ts";

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
