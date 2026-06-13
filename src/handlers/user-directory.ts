import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type { RoomId, UserId } from "../types/index.ts";

type DirectoryEntry = {
	readonly user_id: UserId;
	readonly display_name?: string;
	readonly avatar_url?: string;
};

type MemberContent = {
	readonly membership?: string;
	readonly displayname?: string;
	readonly avatar_url?: string;
};

const anyAsync = async <T>(
	items: readonly T[],
	predicate: (item: T) => Promise<boolean>,
): Promise<boolean> => {
	for (const item of items) {
		if (await predicate(item)) return true;
	}
	return false;
};

const stateContent = <T>(
	room: { state_events: Map<string, PDU> } | undefined,
	key: string,
) => room?.state_events.get(key)?.content as T | undefined;

export const postUserDirectorySearch =
	(storage: Storage): Handler =>
	async (req) => {
		const { search_term, limit: rawLimit } = (req.body ?? {}) as {
			search_term?: string;
			limit?: number;
		};
		if (!search_term) throw badJson("Missing search_term");

		const searcherId = req.userId as UserId;
		const limit = Math.min(Math.max(rawLimit ?? 10, 1), 50);
		const term = search_term.toLowerCase();

		const searcherRooms = await storage.getRoomsForUser(searcherId);
		const searcherRoomSet = new Set(searcherRooms);
		const directoryRooms = new Set(await storage.getPublicRoomIds());

		// A room counts as "public" for directory visibility if it is publicly
		// joinable (join_rules = public) or world-readable, OR it is listed in the
		// public room directory — matching synapse's users_in_public_rooms, which is
		// keyed off the room being publicly accessible rather than merely published.
		// Cached per request since a room is checked once per candidate.
		const publicnessCache = new Map<string, boolean>();
		const isRoomPublic = async (roomId: string): Promise<boolean> => {
			if (directoryRooms.has(roomId as RoomId)) return true;
			const cached = publicnessCache.get(roomId);
			if (cached !== undefined) return cached;
			const room = await storage.getRoom(roomId as RoomId);
			const joinRule = stateContent<{ join_rule?: string }>(
				room,
				"m.room.join_rules\x1f",
			)?.join_rule;
			const historyVisibility = stateContent<{ history_visibility?: string }>(
				room,
				"m.room.history_visibility\x1f",
			)?.history_visibility;
			const pub =
				joinRule === "public" || historyVisibility === "world_readable";
			publicnessCache.set(roomId, pub);
			return pub;
		};

		const results = new Map<string, DirectoryEntry>();

		// 1. Local users from the directory index, filtered by directory visibility
		// (synapse search_user_dir default clause): a candidate is visible if they
		// are in a public room OR they share a room with the searcher. The searcher
		// themselves is only ever surfaced via the public-room path (synapse's
		// users_who_share_private_rooms never pairs a user with themselves), so a
		// user searching a term that matches only their own id is found iff they are
		// in a public room.
		const candidates = await storage.searchUserDirectory(search_term, 200);
		for (const candidate of candidates) {
			if (results.has(candidate.user_id)) continue;
			const isSelf = candidate.user_id === searcherId;
			const candidateRooms = await storage.getRoomsForUser(candidate.user_id);
			const inPublicRoom = await anyAsync(candidateRooms, isRoomPublic);
			const sharesRoom = candidateRooms.some((r) => searcherRoomSet.has(r));
			if (inPublicRoom || (sharesRoom && !isSelf)) {
				results.set(candidate.user_id, candidate);
			}
		}

		// 2. Members (local AND remote) of the searcher's own rooms whose user ID or
		// display name matches. This surfaces remote users we only know via room
		// state — in particular members filled in by a partial-state resync, who are
		// not in the local users table. They are inherently visible (a shared room
		// with the searcher). The searcher is excluded from their own results,
		// matching synapse (search_user_dir: `WHERE user_id != ?`).
		for (const roomId of searcherRooms) {
			const members = await storage.getMemberEvents(roomId as RoomId);
			for (const { event } of members) {
				const uid = event.state_key;
				if (!uid || uid === searcherId || results.has(uid)) continue;
				const { membership, displayname, avatar_url } =
					event.content as MemberContent;
				if (membership !== "join") continue;
				const matches =
					uid.toLowerCase().includes(term) ||
					(displayname?.toLowerCase().includes(term) ?? false);
				if (matches) {
					results.set(uid, {
						user_id: uid as UserId,
						display_name: displayname,
						avatar_url,
					});
				}
			}
		}

		const all = [...results.values()];
		return {
			status: 200,
			body: { results: all.slice(0, limit), limited: all.length > limit },
		};
	};
