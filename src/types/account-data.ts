import type { EventId, RoomId, UserId } from "./identifiers.ts";

export interface DirectContent {
	[userId: string]: RoomId[];
}

export interface IgnoredUserListContent {
	ignored_users: Record<UserId, Record<string, unknown>>;
}

export interface FullyReadContent {
	event_id: EventId;
}

export interface TagContent {
	tags: Record<string, { order?: number }>;
}
