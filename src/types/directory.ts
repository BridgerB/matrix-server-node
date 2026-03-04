import type { StrippedStateEvent } from "./events.ts";
import type { MxcUri, RoomAlias, RoomId, UserId } from "./identifiers.ts";

export interface PublicRoomsRequest {
	limit?: number;
	since?: string;
	filter?: { generic_search_term?: string; room_types?: (string | null)[] };
	include_all_networks?: boolean;
	third_party_instance_id?: string;
}

export interface PublicRoomsResponse {
	chunk: PublicRoomEntry[];
	next_batch?: string;
	prev_batch?: string;
	total_room_count_estimate?: number;
}

export interface PublicRoomEntry {
	room_id: RoomId;
	name?: string;
	topic?: string;
	avatar_url?: MxcUri;
	num_joined_members: number;
	world_readable: boolean;
	guest_can_join: boolean;
	canonical_alias?: RoomAlias;
	aliases?: RoomAlias[];
	join_rule?: string;
	room_type?: string;
}

export interface UserDirectoryRequest {
	search_term: string;
	limit?: number;
}

export interface UserDirectoryResponse {
	results: {
		user_id: UserId;
		display_name?: string;
		avatar_url?: MxcUri;
	}[];
	limited: boolean;
}

export interface SpaceHierarchyResponse {
	rooms: SpaceHierarchyRoom[];
	next_batch?: string;
}

export interface SpaceHierarchyRoom {
	room_id: RoomId;
	name?: string;
	topic?: string;
	avatar_url?: MxcUri;
	canonical_alias?: RoomAlias;
	num_joined_members: number;
	world_readable: boolean;
	guest_can_join: boolean;
	join_rule?: string;
	room_type?: string;
	children_state: StrippedStateEvent[];
}
