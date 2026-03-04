import type { PublicRoomsResponse } from "./directory.ts";
import type { CrossSigningKey, DeviceKeys, OneTimeKey } from "./e2ee.ts";
import type { EDU, PDU, StrippedStateEvent } from "./events.ts";
import type {
	Base64,
	DeviceId,
	EventId,
	KeyId,
	MxcUri,
	ServerName,
	Timestamp,
	UserId,
} from "./identifiers.ts";
import type { RoomVersion } from "./room-versions.ts";

/** Federation transaction sent between servers */
export interface FederationTransaction {
	origin: ServerName;
	origin_server_ts: Timestamp;
	pdus: PDU[];
	edus?: EDU[];
}

/** Server signing key for federation */
export interface ServerKeys {
	server_name: ServerName;
	verify_keys: Record<KeyId, { key: Base64 }>;
	old_verify_keys?: Record<
		KeyId,
		{
			key: Base64;
			expired_ts: Timestamp;
		}
	>;
	signatures: Record<ServerName, Record<KeyId, Base64>>;
	valid_until_ts: Timestamp;
}

/** Federation make_join response */
export interface MakeJoinResponse {
	room_version: RoomVersion;
	event: Partial<PDU>;
}

/** Federation send_join response */
export interface SendJoinResponse {
	origin: ServerName;
	auth_chain: PDU[];
	state: PDU[];
	event?: PDU;
	members_omitted?: boolean;
	servers_in_room?: ServerName[];
}

/** Federation make_leave response */
export interface MakeLeaveResponse {
	room_version: RoomVersion;
	event: Partial<PDU>;
}

/** Federation invite request (v2) */
export interface FederationInviteRequest {
	room_version: RoomVersion;
	event: PDU;
	invite_room_state?: StrippedStateEvent[];
}

/** Federation backfill response */
export interface BackfillResponse {
	origin: ServerName;
	origin_server_ts: Timestamp;
	pdus: PDU[];
}

/** Federation missing events request */
export interface MissingEventsRequest {
	limit?: number;
	min_depth?: number;
	earliest_events: EventId[];
	latest_events: EventId[];
}

/** Federation missing events response */
export interface MissingEventsResponse {
	events: PDU[];
}

/** Federation state request response */
export interface StateResponse {
	auth_chain: PDU[];
	pdus: PDU[];
}

/** Federation event_auth response */
export interface EventAuthResponse {
	auth_chain: PDU[];
}

/** Federation query for user's devices */
export interface FederationDeviceListResponse {
	user_id: UserId;
	stream_id: number;
	devices: {
		device_id: DeviceId;
		device_display_name?: string;
		keys: DeviceKeys;
	}[];
	master_key?: CrossSigningKey;
	self_signing_key?: CrossSigningKey;
}

/** Federation user key claim response */
export interface FederationKeyClaimResponse {
	one_time_keys: Record<
		UserId,
		Record<DeviceId, Record<KeyId, string | OneTimeKey>>
	>;
}

/** Federation public rooms query */
export interface FederationPublicRoomsResponse extends PublicRoomsResponse {}

/** Federation profile query */
export interface FederationProfileResponse {
	displayname?: string;
	avatar_url?: MxcUri;
}
