import type { ClientEvent, StrippedStateEvent } from "./events.ts";
import type { MxcUri, RoomId, Timestamp, UserId } from "./identifiers.ts";
import type { JsonObject } from "./json.ts";

export interface SlidingSyncRequest {
	conn_id?: string;
	txn_id?: string;
	pos?: string;
	lists?: Record<string, SlidingSyncList>;
	room_subscriptions?: Record<RoomId, RoomSubscription>;
	unsubscribe_rooms?: RoomId[];
	extensions?: SlidingSyncExtensions;
}

export interface SlidingSyncList {
	ranges?: [number, number][];
	sort?: string[];
	required_state?: [string, string][]; // [event_type, state_key]
	timeline_limit?: number;
	filters?: SlidingSyncFilters;
	include_heroes?: boolean;
	bump_event_types?: string[];
}

export interface SlidingSyncFilters {
	is_dm?: boolean;
	spaces?: RoomId[];
	is_encrypted?: boolean;
	is_invite?: boolean;
	room_types?: (string | null)[];
	not_room_types?: string[];
	room_name_like?: string;
	tags?: string[];
	not_tags?: string[];
}

export interface RoomSubscription {
	required_state?: [string, string][];
	timeline_limit?: number;
	include_heroes?: boolean;
}

export interface SlidingSyncExtensions {
	to_device?: { enabled: boolean; since?: string; limit?: number };
	e2ee?: { enabled: boolean };
	account_data?: { enabled: boolean; lists?: string[]; rooms?: RoomId[] };
	typing?: { enabled: boolean; lists?: string[]; rooms?: RoomId[] };
	receipts?: { enabled: boolean; lists?: string[]; rooms?: RoomId[] };
}

export interface SlidingSyncResponse {
	pos: string;
	txn_id?: string;
	lists?: Record<string, SlidingSyncListResponse>;
	rooms?: Record<RoomId, SlidingSyncRoom>;
	extensions?: JsonObject;
}

export interface SlidingSyncListResponse {
	count: number;
	ops?: SlidingSyncOp[];
}

export interface SlidingSyncOp {
	op: "SYNC" | "INSERT" | "DELETE" | "INVALIDATE";
	range?: [number, number];
	index?: number;
	room_ids?: RoomId[];
	room_id?: RoomId;
}

export interface SlidingSyncRoom {
	name?: string;
	avatar?: MxcUri;
	heroes?: SlidingSyncHero[];
	initial?: boolean;
	required_state?: ClientEvent[];
	timeline?: ClientEvent[];
	is_dm?: boolean;
	invite_state?: StrippedStateEvent[];
	notification_count?: number;
	highlight_count?: number;
	joined_count?: number;
	invited_count?: number;
	num_live?: number;
	timestamp?: Timestamp;
	prev_batch?: string;
	bump_stamp?: Timestamp;
}

export interface SlidingSyncHero {
	user_id: UserId;
	name?: string;
	avatar?: MxcUri;
}
