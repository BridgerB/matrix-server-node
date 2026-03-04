// =============================================================================
// ROOM OPERATIONS
// =============================================================================

import type { ClientEvent } from "./events.ts";
import type { RoomEventFilter } from "./filters.ts";
import type { MxcUri, RoomId, UserId } from "./identifiers.ts";
import type { JsonObject } from "./json.ts";
import type { RoomVersion } from "./room-versions.ts";
import type { RoomPowerLevelsContent } from "./state-events.ts";

export interface CreateRoomRequest {
	visibility?: "public" | "private";
	room_alias_name?: string;
	name?: string;
	topic?: string;
	invite?: UserId[];
	invite_3pid?: Invite3pid[];
	room_version?: RoomVersion;
	creation_content?: JsonObject;
	initial_state?: StateEventInput[];
	preset?: "private_chat" | "public_chat" | "trusted_private_chat";
	is_direct?: boolean;
	power_level_content_override?: RoomPowerLevelsContent;
}

export interface Invite3pid {
	id_server: string;
	id_access_token: string;
	medium: "email";
	address: string;
}

export interface StateEventInput {
	type: string;
	state_key?: string;
	content: JsonObject;
}

export interface CreateRoomResponse {
	room_id: RoomId;
}

// =============================================================================
// MESSAGES / CONTEXT / SEARCH
// =============================================================================

export interface MessagesRequest {
	from: string;
	to?: string;
	dir: "b" | "f"; // backward or forward
	limit?: number;
	filter?: string | RoomEventFilter;
}

export interface MessagesResponse {
	start: string;
	end?: string;
	chunk: ClientEvent[];
	state?: ClientEvent[];
}

export interface ContextResponse {
	start: string;
	end: string;
	event: ClientEvent;
	events_before: ClientEvent[];
	events_after: ClientEvent[];
	state: ClientEvent[];
}

export interface SearchRequest {
	search_categories: {
		room_events?: {
			search_term: string;
			keys?: ("content.body" | "content.name" | "content.topic")[];
			filter?: RoomEventFilter;
			order_by?: "recent" | "rank";
			event_context?: {
				before_limit?: number;
				after_limit?: number;
				include_profile?: boolean;
			};
			include_state?: boolean;
			groupings?: { group_by?: { key: "room_id" | "sender" }[] };
		};
	};
}

export interface SearchResponse {
	search_categories: {
		room_events?: {
			count: number;
			highlights: string[];
			results: SearchResult[];
			state?: Record<RoomId, ClientEvent[]>;
			groups?: Record<
				string,
				Record<
					string,
					{ results: string[]; order: number; next_batch?: string }
				>
			>;
			next_batch?: string;
		};
	};
}

export interface SearchResult {
	rank: number;
	result: ClientEvent;
	context?: {
		start?: string;
		end?: string;
		events_before: ClientEvent[];
		events_after: ClientEvent[];
		profile_info?: Record<
			UserId,
			{ displayname?: string; avatar_url?: MxcUri }
		>;
	};
}

// =============================================================================
// RELATIONS / AGGREGATIONS
// =============================================================================

export interface RelationsResponse {
	chunk: ClientEvent[];
	next_batch?: string;
	prev_batch?: string;
	recursion_depth?: number;
}

export interface ThreadsResponse {
	chunk: ClientEvent[];
	next_batch?: string;
}
