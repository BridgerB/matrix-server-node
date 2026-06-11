import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, UserId } from "../types/index.ts";

type DirectoryEntry = {
	user_id: UserId;
	display_name?: string;
	avatar_url?: string;
};

export const postUserDirectorySearch =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as { search_term?: string; limit?: number };
		if (!body.search_term) throw badJson("Missing search_term");

		const searcherId = req.userId as UserId;
		const limit = Math.min(Math.max(body.limit ?? 10, 1), 50);
		const term = body.search_term.toLowerCase();

		const searcherRooms = await storage.getRoomsForUser(searcherId);
		const searcherRoomSet = new Set(searcherRooms);
		const publicRooms = new Set(await storage.getPublicRoomIds());

		const results = new Map<string, DirectoryEntry>();

		// 1. Local users from the directory index, filtered by directory
		// visibility: visible to the searcher only if they share a room or are in
		// a public room.
		const candidates = await storage.searchUserDirectory(body.search_term, 200);
		for (const candidate of candidates) {
			if (results.has(candidate.user_id)) continue;
			const candidateRooms = await storage.getRoomsForUser(candidate.user_id);
			const sharesRoom = candidateRooms.some((r) => searcherRoomSet.has(r));
			const inPublicRoom = candidateRooms.some((r) => publicRooms.has(r));
			if (sharesRoom || inPublicRoom) results.set(candidate.user_id, candidate);
		}

		// 2. Members (local AND remote) of the searcher's own rooms whose user ID
		// or display name matches. This surfaces remote users we only know via
		// room state — in particular members filled in by a partial-state resync,
		// who are not in the local users table. They are inherently visible (a
		// shared room with the searcher). The searcher may match here and appears
		// in their own results, which is what the spec's directory expects.
		for (const roomId of searcherRooms) {
			const members = await storage.getMemberEvents(roomId as RoomId);
			for (const m of members) {
				const uid = m.event.state_key;
				if (!uid || results.has(uid)) continue;
				const content = m.event.content as {
					membership?: string;
					displayname?: string;
					avatar_url?: string;
				};
				if (content.membership !== "join") continue;
				const dn = content.displayname;
				if (
					uid.toLowerCase().includes(term) ||
					(dn?.toLowerCase().includes(term) ?? false)
				) {
					results.set(uid, {
						user_id: uid as UserId,
						display_name: dn,
						avatar_url: content.avatar_url,
					});
				}
			}
		}

		const all = [...results.values()];
		const limited = all.length > limit;
		const sliced = all.slice(0, limit);

		return {
			status: 200,
			body: { results: sliced, limited },
		};
	};
