// =============================================================================
// EVENT CONTENT TYPES - ACCOUNT DATA
// =============================================================================

import type { UserId, RoomId, EventId } from "./identifiers.ts";

export interface DirectContent {
	[userId: string]: RoomId[];
}

export interface IgnoredUserListContent {
	ignored_users: Record<UserId, {}>;
}

export interface FullyReadContent {
	event_id: EventId;
}

export interface TagContent {
	tags: Record<string, { order?: number }>;
}
