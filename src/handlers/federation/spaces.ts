import { forbidden, notFound } from "../../errors.ts";
import { contentField, iterMembers, roomSummaryFields } from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import { domainOf } from "../../ids.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { StrippedStateEvent } from "../../types/events.ts";
import type { RoomId, ServerName } from "../../types/index.ts";

type RoomState = NonNullable<Awaited<ReturnType<Storage["getRoom"]>>>;

interface FederationRoomEntry {
	room_id: string;
	name?: string;
	topic?: string;
	avatar_url?: string;
	canonical_alias?: string;
	num_joined_members: number;
	world_readable: boolean;
	guest_can_join: boolean;
	join_rule?: string;
	room_type?: string;
	children_state: StrippedStateEvent[];
	allowed_room_ids: string[];
}

/**
 * The list of room IDs whose membership grants access to `room` via a
 * `restricted` (or `knock_restricted`) join rule (MSC3083).
 */
export const getAllowedRoomIds = (room: RoomState): string[] => {
	const joinRulesEvent = room.state_events.get("m.room.join_rules\x1f");
	if (!joinRulesEvent) return [];
	const content = joinRulesEvent.content as Record<string, unknown>;
	const joinRule = content.join_rule;
	if (joinRule !== "restricted" && joinRule !== "knock_restricted") return [];
	const allow = content.allow;
	if (!Array.isArray(allow)) return [];
	const result: string[] = [];
	for (const entry of allow) {
		if (
			entry &&
			typeof entry === "object" &&
			(entry as Record<string, unknown>).type === "m.room_membership"
		) {
			const roomId = (entry as Record<string, unknown>).room_id;
			if (typeof roomId === "string") result.push(roomId);
		}
	}
	return result;
};

/** True if any user from `origin` is joined to `room`. */
const isHostInRoom = (room: RoomState, origin: ServerName): boolean => {
	for (const { userId, membership } of iterMembers(room.state_events)) {
		if (membership !== "join" && membership !== "invite") continue;
		if (domainOf(userId) === origin) return true;
	}
	return false;
};

/**
 * Whether a room received/served over federation should be shown to the
 * requesting `origin` server. Mirrors Synapse's `_is_local_room_accessible`
 * for the federation (origin) path.
 */
export const isRoomAccessibleToServer = async (
	storage: Storage,
	room: RoomState,
	origin: ServerName,
): Promise<boolean> => {
	const joinRule = contentField(
		room.state_events.get("m.room.join_rules\x1f"),
		"join_rule",
	);
	if (
		joinRule === "public" ||
		joinRule === "knock" ||
		joinRule === "knock_restricted"
	) {
		return true;
	}

	const histVis = contentField(
		room.state_events.get("m.room.history_visibility\x1f"),
		"history_visibility",
	);
	if (histVis === "world_readable") return true;

	// Host is in the room (has a joined/invited user).
	if (isHostInRoom(room, origin)) return true;

	// Restricted: host has a user in one of the allowed rooms.
	for (const allowedRoomId of getAllowedRoomIds(room)) {
		const allowedRoom = await storage.getRoom(allowedRoomId as RoomId);
		if (allowedRoom && isHostInRoom(allowedRoom, origin)) return true;
	}

	return false;
};

export const buildFederationRoomEntry = (
	room: RoomState,
	roomId: string,
	suggestedOnly: boolean,
): FederationRoomEntry => {
	const childrenState: StrippedStateEvent[] = [];
	for (const [key, event] of room.state_events) {
		if (!key.startsWith("m.space.child\x1f")) continue;
		const content = event.content as Record<string, unknown>;
		if (!content.via || !Array.isArray(content.via)) continue;
		if (suggestedOnly && !content.suggested) continue;
		childrenState.push({
			content: event.content,
			sender: event.sender,
			state_key: event.state_key ?? "",
			type: event.type,
		});
	}

	return {
		room_id: roomId,
		...roomSummaryFields(room),
		children_state: childrenState,
		allowed_room_ids: getAllowedRoomIds(room),
	};
};

/**
 * GET /_matrix/federation/v1/hierarchy/:roomId
 *
 * Returns this server's view of a single space's hierarchy: the requested room
 * plus a one-level summary of each child room that lives on this server.
 * The requesting server must be able to see each room (per MSC2946 visibility).
 */
export const postFederationHierarchy =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const origin = req.origin as ServerName;
		const suggestedOnly = req.query.get("suggested_only") === "true";

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(origin, room))
			throw forbidden("Server is denied by ACL");

		// The requesting server must be able to see the root room.
		if (!(await isRoomAccessibleToServer(storage, room, origin)))
			throw notFound("Room not found");

		const roomEntry = buildFederationRoomEntry(room, roomId, suggestedOnly);

		const children: FederationRoomEntry[] = [];
		const inaccessibleChildren: string[] = [];

		for (const childState of roomEntry.children_state) {
			const childId = childState.state_key;
			if (!childId) continue;
			const childRoom = await storage.getRoom(childId as RoomId);
			if (!childRoom) {
				// We don't have this room locally; the requesting server must
				// fetch it from whichever server does.
				inaccessibleChildren.push(childId);
				continue;
			}
			if (!(await isRoomAccessibleToServer(storage, childRoom, origin))) {
				inaccessibleChildren.push(childId);
				continue;
			}
			children.push(
				buildFederationRoomEntry(childRoom, childId, suggestedOnly),
			);
		}

		return {
			status: 200,
			body: {
				room: roomEntry,
				children,
				inaccessible_children: inaccessibleChildren,
			},
		};
	};
