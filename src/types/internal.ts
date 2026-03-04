import type { PDU } from "./events.ts";
import type {
	Base64,
	DeviceId,
	EventId,
	RoomId,
	ServerName,
	Timestamp,
	UserId,
} from "./identifiers.ts";
import type { RoomVersion } from "./room-versions.ts";

/** Internal representation of a room */
export interface RoomState {
	room_id: RoomId;
	room_version: RoomVersion;
	/** Current state map: "event_type\0state_key" -> event */
	state_events: Map<string, PDU>;
	depth: number;
	forward_extremities: EventId[];
}

/** Internal user account record */
export interface UserAccount {
	user_id: UserId;
	localpart: string;
	server_name: ServerName;
	password_hash: string;
	account_type: "user" | "guest" | "admin" | "appservice";
	is_deactivated: boolean;
	created_at: Timestamp;
	displayname?: string;
	avatar_url?: string;
}

/** Internal device session */
export interface DeviceSession {
	device_id: DeviceId;
	user_id: UserId;
	access_token_hash: string;
	display_name?: string;
	last_seen_ip?: string;
	last_seen_ts?: Timestamp;
	user_agent?: string;
}

/** Internal representation of stored media */
export interface StoredMedia {
	media_id: string;
	origin: ServerName;
	user_id?: UserId;
	content_type: string;
	upload_name?: string;
	file_size: number;
	content_hash: Base64;
	created_at: Timestamp;
	quarantined: boolean;
}
