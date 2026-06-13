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
		const directoryRooms = new Set(await storage.getPublicRoomIds());

		// A room counts as "public" for directory visibility if it is publicly
		// joinable (join_rules = public) or world-readable, OR it is listed in the
		// public room directory — matching synapse's users_in_public_rooms, which
		// is keyed off the room being publicly accessible rather than merely
		// published. Cached per request since a room is checked once per candidate.
		const publicnessCache = new Map<string, boolean>();
		const isRoomPublic = async (roomId: string): Promise<boolean> => {
			if (directoryRooms.has(roomId as RoomId)) return true;
			const cached = publicnessCache.get(roomId);
			if (cached !== undefined) return cached;
			const room = await storage.getRoom(roomId as RoomId);
			let pub = false;
			if (room) {
				const jr = room.state_events.get("m.room.join_rules\x1f");
				if (
					(jr?.content as { join_rule?: string } | undefined)?.join_rule ===
					"public"
				)
					pub = true;
				const hv = room.state_events.get("m.room.history_visibility\x1f");
				if (
					(hv?.content as { history_visibility?: string } | undefined)
						?.history_visibility === "world_readable"
				)
					pub = true;
			}
			publicnessCache.set(roomId, pub);
			return pub;
		};

		const results = new Map<string, DirectoryEntry>();

		// 1. Local users from the directory index, filtered by directory
		// visibility (synapse search_user_dir default clause): a candidate is
		// visible if they are in a public room OR they share a room with the
		// searcher. The searcher themselves is only ever surfaced via the
		// public-room path (synapse's users_who_share_private_rooms never pairs a
		// user with themselves), so a user searching a term that matches only
		// their own id is found iff they are in a public room.
		const candidates = await storage.searchUserDirectory(body.search_term, 200);
		for (const candidate of candidates) {
			if (results.has(candidate.user_id)) continue;
			const isSelf = candidate.user_id === searcherId;
			const candidateRooms = await storage.getRoomsForUser(candidate.user_id);
			let inPublicRoom = false;
			for (const r of candidateRooms) {
				if (await isRoomPublic(r)) {
					inPublicRoom = true;
					break;
				}
			}
			const sharesRoom = candidateRooms.some((r) => searcherRoomSet.has(r));
			if (inPublicRoom || (sharesRoom && !isSelf)) {
				results.set(candidate.user_id, candidate);
			}
		}

		// 2. Members (local AND remote) of the searcher's own rooms whose user ID
		// or display name matches. This surfaces remote users we only know via
		// room state — in particular members filled in by a partial-state resync,
		// who are not in the local users table. They are inherently visible (a
		// shared room with the searcher). The searcher is excluded from their own
		// results, matching synapse (search_user_dir: `WHERE user_id != ?`).
		for (const roomId of searcherRooms) {
			const members = await storage.getMemberEvents(roomId as RoomId);
			for (const m of members) {
				const uid = m.event.state_key;
				if (!uid || uid === searcherId || results.has(uid)) continue;
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
