// =============================================================================
// FILTERS
// =============================================================================

import type { UserId, RoomId } from "./identifiers.ts";

export interface SyncFilter {
	event_fields?: string[];
	event_format?: "client" | "federation";
	presence?: EventFilter;
	account_data?: EventFilter;
	room?: RoomFilter;
}

export interface RoomFilter {
	not_rooms?: RoomId[];
	rooms?: RoomId[];
	ephemeral?: RoomEventFilter;
	include_leave?: boolean;
	state?: StateFilter;
	timeline?: RoomEventFilter;
	account_data?: RoomEventFilter;
}

export interface EventFilter {
	limit?: number;
	not_senders?: UserId[];
	not_types?: string[];
	senders?: UserId[];
	types?: string[];
}

export interface RoomEventFilter extends EventFilter {
	lazy_load_members?: boolean;
	include_redundant_members?: boolean;
	not_rooms?: RoomId[];
	rooms?: RoomId[];
	contains_url?: boolean;
	unread_thread_notifications?: boolean;
}

export interface StateFilter extends RoomEventFilter {
	include_redundant_members?: boolean;
}
