import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId } from "../types/index.ts";
import type { SpaceHierarchyRoom } from "../types/directory.ts";
import type { StrippedStateEvent } from "../types/events.ts";
import { getMembership } from "../events.ts";
import { notFound } from "../errors.ts";

// =============================================================================
// GET /_matrix/client/v3/rooms/:roomId/hierarchy
// =============================================================================

const MAX_ROOMS = 50;

export function getSpaceHierarchy(storage: Storage): Handler {
	return async (req) => {
		const rootRoomId = req.params["roomId"]! as RoomId;
		const userId = req.userId!;

		const limitStr = req.query.get("limit");
		const limit = Math.min(
			Math.max(parseInt(limitStr ?? String(MAX_ROOMS), 10), 1),
			MAX_ROOMS,
		);
		const maxDepth = Math.max(
			parseInt(req.query.get("max_depth") ?? "50", 10),
			0,
		);
		const from = req.query.get("from") ?? undefined;

		const rootRoom = await storage.getRoom(rootRoomId);
		if (!rootRoom) throw notFound("Room not found");

		// BFS traversal
		const visited = new Set<RoomId>();
		const rooms: SpaceHierarchyRoom[] = [];
		const queue: { roomId: RoomId; depth: number }[] = [
			{ roomId: rootRoomId, depth: 0 },
		];

		// Handle pagination: skip rooms until we reach the 'from' marker
		let skipping = from !== undefined;

		while (queue.length > 0 && rooms.length < limit) {
			const { roomId, depth } = queue.shift()!;
			if (visited.has(roomId)) continue;
			visited.add(roomId);

			const room = await storage.getRoom(roomId);
			if (!room) continue;

			// Check if user can see this room (joined or room is world-readable/public)
			const membership = getMembership(room, userId);
			const historyEvent = room.state_events.get("m.room.history_visibility\0");
			const historyVis = historyEvent
				? (historyEvent.content as Record<string, unknown>)[
						"history_visibility"
					]
				: "shared";
			const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
			const joinRule = joinRulesEvent
				? (joinRulesEvent.content as Record<string, unknown>)["join_rule"]
				: "invite";

			const canSee =
				membership === "join" ||
				historyVis === "world_readable" ||
				joinRule === "public";
			if (!canSee && roomId !== rootRoomId) continue;

			// Collect m.space.child state events
			const childrenState: StrippedStateEvent[] = [];
			const childRoomIds: RoomId[] = [];

			for (const [key, event] of room.state_events) {
				if (key.startsWith("m.space.child\0")) {
					const childRoomId = event.state_key as RoomId;
					const content = event.content as Record<string, unknown>;
					// Only include children with a "via" key (active children)
					if (content["via"] && Array.isArray(content["via"])) {
						childrenState.push({
							content: event.content,
							sender: event.sender,
							state_key: event.state_key ?? "",
							type: event.type,
						});
						childRoomIds.push(childRoomId);
					}
				}
			}

			if (skipping) {
				if (roomId === from) {
					skipping = false;
				}
				// Still enqueue children for traversal even while skipping
				if (depth < maxDepth) {
					for (const childId of childRoomIds) {
						queue.push({ roomId: childId, depth: depth + 1 });
					}
				}
				continue;
			}

			// Build room entry
			const entry = buildHierarchyRoom(room, roomId, childrenState);
			rooms.push(entry);

			// Enqueue children for traversal
			if (depth < maxDepth) {
				for (const childId of childRoomIds) {
					queue.push({ roomId: childId, depth: depth + 1 });
				}
			}
		}

		// Determine next_batch
		const nextBatch =
			queue.length > 0 && rooms.length === limit
				? rooms[rooms.length - 1]!.room_id
				: undefined;

		return {
			status: 200,
			body: { rooms, next_batch: nextBatch },
		};
	};
}

function buildHierarchyRoom(
	room: {
		state_events: Map<string, import("../types/events.ts").PDU>;
		room_id: string;
	},
	roomId: RoomId,
	childrenState: StrippedStateEvent[],
): SpaceHierarchyRoom {
	const nameEvent = room.state_events.get("m.room.name\0");
	const topicEvent = room.state_events.get("m.room.topic\0");
	const avatarEvent = room.state_events.get("m.room.avatar\0");
	const aliasEvent = room.state_events.get("m.room.canonical_alias\0");
	const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
	const histVisEvent = room.state_events.get("m.room.history_visibility\0");
	const guestEvent = room.state_events.get("m.room.guest_access\0");
	const createEvent = room.state_events.get("m.room.create\0");

	// Count joined members
	let memberCount = 0;
	for (const [key, event] of room.state_events) {
		if (key.startsWith("m.room.member\0")) {
			if ((event.content as Record<string, unknown>)["membership"] === "join") {
				memberCount++;
			}
		}
	}

	const histVis = histVisEvent
		? (histVisEvent.content as Record<string, unknown>)["history_visibility"]
		: "shared";
	const guestAccess = guestEvent
		? (guestEvent.content as Record<string, unknown>)["guest_access"]
		: "forbidden";

	return {
		room_id: roomId,
		name: nameEvent
			? ((nameEvent.content as Record<string, unknown>)["name"] as string)
			: undefined,
		topic: topicEvent
			? ((topicEvent.content as Record<string, unknown>)["topic"] as string)
			: undefined,
		avatar_url: avatarEvent
			? ((avatarEvent.content as Record<string, unknown>)["url"] as string)
			: undefined,
		canonical_alias: aliasEvent
			? ((aliasEvent.content as Record<string, unknown>)["alias"] as string)
			: undefined,
		num_joined_members: memberCount,
		world_readable: histVis === "world_readable",
		guest_can_join: guestAccess === "can_join",
		join_rule: joinRulesEvent
			? ((joinRulesEvent.content as Record<string, unknown>)[
					"join_rule"
				] as string)
			: undefined,
		room_type: createEvent
			? ((createEvent.content as Record<string, unknown>)["type"] as string)
			: undefined,
		children_state: childrenState,
	};
}
