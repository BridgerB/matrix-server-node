import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";

export const postUserDirectorySearch =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as { search_term?: string; limit?: number };
		if (!body.search_term) throw badJson("Missing search_term");

		const searcherId = req.userId as UserId;
		const limit = Math.min(Math.max(body.limit ?? 10, 1), 50);

		// Gather term matches, then apply directory visibility: a user is only
		// visible to the searcher if they share a room or are in a public room,
		// and the searcher never appears in their own results.
		const candidates = await storage.searchUserDirectory(body.search_term, 200);
		const searcherRooms = new Set(await storage.getRoomsForUser(searcherId));
		const publicRooms = new Set(await storage.getPublicRoomIds());

		const visible: typeof candidates = [];
		for (const candidate of candidates) {
			if (candidate.user_id === searcherId) continue;
			const candidateRooms = await storage.getRoomsForUser(candidate.user_id);
			const sharesRoom = candidateRooms.some((r) => searcherRooms.has(r));
			const inPublicRoom = candidateRooms.some((r) => publicRooms.has(r));
			if (sharesRoom || inPublicRoom) visible.push(candidate);
		}

		const limited = visible.length > limit;
		const sliced = visible.slice(0, limit);

		return {
			status: 200,
			body: { results: sliced, limited },
		};
	};
