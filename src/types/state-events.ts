import type {
	Base64,
	EventId,
	KeyId,
	MxcUri,
	RoomAlias,
	RoomId,
	ServerName,
	UserId,
} from "./identifiers.ts";
import type { ImageInfo } from "./media-info.ts";
import type { RoomVersion } from "./room-versions.ts";

export interface RoomCreateContent {
	creator?: UserId; // deprecated in v11, but still common
	room_version?: RoomVersion;
	federate?: boolean; // default true
	type?: string; // e.g. "m.space"
	predecessor?: {
		room_id: RoomId;
		event_id: EventId;
	};
	additional_creators?: UserId[]; // room version 12+
}

export type Membership = "invite" | "join" | "knock" | "leave" | "ban";

export interface RoomMemberContent {
	membership: Membership;
	displayname?: string;
	avatar_url?: MxcUri;
	is_direct?: boolean;
	reason?: string;
	join_authorised_via_users_server?: UserId;
	third_party_invite?: {
		display_name: string;
		signed: {
			mxid: UserId;
			token: string;
			signatures: Record<ServerName, Record<KeyId, Base64>>;
		};
	};
}

export interface RoomPowerLevelsContent {
	ban?: number; // default 50
	events?: Record<string, number>;
	events_default?: number; // default 0
	invite?: number; // default 0
	kick?: number; // default 50
	redact?: number; // default 50
	state_default?: number; // default 50
	users?: Record<UserId, number>;
	users_default?: number; // default 0
	notifications?: {
		room?: number; // default 50
	};
}

export type JoinRule =
	| "public"
	| "knock"
	| "invite"
	| "private"
	| "restricted"
	| "knock_restricted";

export interface AllowCondition {
	type: "m.room_membership";
	room_id: RoomId;
}

export interface RoomJoinRulesContent {
	join_rule: JoinRule;
	allow?: AllowCondition[];
}

export type HistoryVisibility =
	| "invited"
	| "joined"
	| "shared"
	| "world_readable";

export interface RoomHistoryVisibilityContent {
	history_visibility: HistoryVisibility;
}

export interface RoomNameContent {
	name: string;
}

export interface RoomTopicContent {
	topic: string;
}

export interface RoomAvatarContent {
	url: MxcUri;
	info?: ImageInfo;
}

export interface RoomCanonicalAliasContent {
	alias?: RoomAlias;
	alt_aliases?: RoomAlias[];
}

export type GuestAccess = "can_join" | "forbidden";

export interface RoomGuestAccessContent {
	guest_access: GuestAccess;
}

export interface RoomEncryptionContent {
	algorithm: "m.megolm.v1.aes-sha2";
	rotation_period_ms?: number; // default 604800000 (1 week)
	rotation_period_msgs?: number; // default 100
}

export interface RoomTombstoneContent {
	body: string;
	replacement_room: RoomId;
}

export interface RoomPinnedEventsContent {
	pinned: EventId[];
}

export interface RoomServerAclContent {
	allow: string[]; // glob patterns
	deny: string[]; // glob patterns
	allow_ip_literals: boolean; // default true
}

export interface RoomThirdPartyInviteContent {
	display_name: string;
	key_validity_url: string;
	public_key: string;
	public_keys?: {
		key_validity_url?: string;
		public_key: string;
	}[];
}
