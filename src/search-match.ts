import type { PDU } from "./types/events.ts";

/** The event-content fields that a search `key` can address. */
const fieldForKey = (
	content: Record<string, unknown>,
	key: string,
): unknown => {
	switch (key) {
		case "content.body":
			return content.body;
		case "content.name":
			return content.name;
		case "content.topic":
			return content.topic;
		default:
			return undefined;
	}
};

/**
 * Whether an event matches a search term. The term is split into words and an
 * event matches if any of the requested keys holds a string containing every
 * word (case-insensitive) — i.e. searching "Message 4" matches "Message number 4".
 */
export const eventMatchesSearchTerm = (
	event: PDU,
	keys: string[],
	searchTerm: string,
): boolean => {
	const words = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return false;

	const content = event.content as Record<string, unknown>;
	return keys.some((key) => {
		const field = fieldForKey(content, key);
		if (typeof field !== "string") return false;
		const haystack = field.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
};

/**
 * Given all matching events ordered newest-first, slice out one page starting
 * after `from` (a stream position) and report the total match count and the
 * next pagination token.
 */
export const paginateSearchMatches = <
	T extends { streamPos: number },
>(
	allMatches: T[],
	limit: number,
	from?: string,
): { events: T[]; count: number; nextBatch?: string } => {
	const count = allMatches.length;
	const fromPos = from ? parseInt(from, 10) : undefined;
	const pageSource =
		fromPos !== undefined
			? allMatches.filter((m) => m.streamPos < fromPos)
			: allMatches;
	const events = pageSource.slice(0, limit);
	// next_batch is present whenever this page returned results (its value is the
	// last result's stream position); the terminal page returns zero results and
	// therefore no next_batch. This matches Complement's pagination expectations.
	const nextBatch =
		events.length > 0
			? String(events[events.length - 1]?.streamPos)
			: undefined;
	return { events, count, nextBatch };
};
