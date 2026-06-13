import { globMatch } from "./glob.ts";
import type { ClientEvent } from "./types/events.ts";
import type { RoomEventFilter } from "./types/filters.ts";
import type { UserId } from "./types/index.ts";

/** True if `type` matches any pattern in the list (patterns may contain `*`). */
const matchesAny = (patterns: string[], value: string): boolean =>
	patterns.some((p) => globMatch(p, value));

/**
 * Apply a Matrix RoomEventFilter to a single event. Supports the fields that
 * affect which events are returned: types/not_types (with `*` wildcards),
 * senders/not_senders, and contains_url. Returns false if the event is excluded.
 */
export const matchesRoomEventFilter = (
	event: ClientEvent,
	filter: RoomEventFilter | undefined,
): boolean => {
	if (!filter) return true;

	if (filter.types && !matchesAny(filter.types, event.type)) return false;
	if (filter.not_types && matchesAny(filter.not_types, event.type))
		return false;

	if (filter.senders && !filter.senders.includes(event.sender as UserId)) {
		return false;
	}
	if (filter.not_senders?.includes(event.sender as UserId)) return false;

	if (filter.contains_url !== undefined) {
		const hasUrl =
			typeof (event.content as Record<string, unknown>)?.url === "string";
		if (hasUrl !== filter.contains_url) return false;
	}

	return true;
};

/** Parse a `filter` query-string value (URL-decoded JSON) into a RoomEventFilter. */
export const parseRoomEventFilter = (
	raw: string | null,
): RoomEventFilter | undefined => {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed as RoomEventFilter;
	} catch {
		// Ignore malformed filters — treat as no filter.
	}
	return undefined;
};
