import { forbidden, notFound } from "../../errors.ts";
import { countJoinedMembers } from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { StrippedStateEvent } from "../../types/events.ts";
import type { RoomId, ServerName } from "../../types/index.ts";

export const postFederationHierarchy =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const suggestedOnly =
			req.query.get("suggested_only") === "true";

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		const nameEvent = room.state_events.get("m.room.name\0");
		const topicEvent = room.state_events.get("m.room.topic\0");
		const avatarEvent = room.state_events.get("m.room.avatar\0");
		const aliasEvent = room.state_events.get("m.room.canonical_alias\0");
		const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
		const histVisEvent = room.state_events.get(
			"m.room.history_visibility\0",
		);
		const guestEvent = room.state_events.get("m.room.guest_access\0");
		const createEvent = room.state_events.get("m.room.create\0");

		const memberCount = countJoinedMembers(room.state_events);

		const histVis = histVisEvent
			? (histVisEvent.content as Record<string, unknown>)
					.history_visibility
			: "shared";
		const guestAccess = guestEvent
			? (guestEvent.content as Record<string, unknown>).guest_access
			: "forbidden";

		const childrenState: StrippedStateEvent[] = [];
		const childRoomIds: RoomId[] = [];

		for (const [key, event] of room.state_events) {
			if (key.startsWith("m.space.child\0")) {
				const content = event.content as Record<string, unknown>;
				if (content.via && Array.isArray(content.via)) {
					if (
						suggestedOnly &&
						!(content as Record<string, unknown>).suggested
					)
						continue;
					childrenState.push({
						content: event.content,
						sender: event.sender,
						state_key: event.state_key ?? "",
						type: event.type,
					});
					childRoomIds.push(event.state_key as RoomId);
				}
			}
		}

		const roomEntry = {
			room_id: roomId,
			name: nameEvent
				? ((nameEvent.content as Record<string, unknown>).name as string)
				: undefined,
			topic: topicEvent
				? ((topicEvent.content as Record<string, unknown>).topic as string)
				: undefined,
			avatar_url: avatarEvent
				? ((avatarEvent.content as Record<string, unknown>).url as string)
				: undefined,
			canonical_alias: aliasEvent
				? ((aliasEvent.content as Record<string, unknown>).alias as string)
				: undefined,
			num_joined_members: memberCount,
			world_readable: histVis === "world_readable",
			guest_can_join: guestAccess === "can_join",
			join_rule: joinRulesEvent
				? ((joinRulesEvent.content as Record<string, unknown>)
						.join_rule as string)
				: undefined,
			room_type: createEvent
				? ((createEvent.content as Record<string, unknown>).type as string)
				: undefined,
			children_state: childrenState,
			allowed_room_ids: [] as string[],
		};

		// Build children entries
		const children = [];
		const inaccessibleChildren: string[] = [];

		for (const childId of childRoomIds) {
			const childRoom = await storage.getRoom(childId);
			if (!childRoom) {
				inaccessibleChildren.push(childId);
				continue;
			}

			const cNameEvent = childRoom.state_events.get("m.room.name\0");
			const cTopicEvent = childRoom.state_events.get("m.room.topic\0");
			const cAvatarEvent = childRoom.state_events.get("m.room.avatar\0");
			const cAliasEvent = childRoom.state_events.get(
				"m.room.canonical_alias\0",
			);
			const cJoinRulesEvent = childRoom.state_events.get(
				"m.room.join_rules\0",
			);
			const cHistVisEvent = childRoom.state_events.get(
				"m.room.history_visibility\0",
			);
			const cGuestEvent = childRoom.state_events.get(
				"m.room.guest_access\0",
			);
			const cCreateEvent = childRoom.state_events.get("m.room.create\0");

			const cMemberCount = countJoinedMembers(childRoom.state_events);
			const cHistVis = cHistVisEvent
				? (cHistVisEvent.content as Record<string, unknown>)
						.history_visibility
				: "shared";
			const cGuestAccess = cGuestEvent
				? (cGuestEvent.content as Record<string, unknown>).guest_access
				: "forbidden";

			// Collect this child's own children
			const cChildrenState: StrippedStateEvent[] = [];
			for (const [key, event] of childRoom.state_events) {
				if (key.startsWith("m.space.child\0")) {
					const content = event.content as Record<string, unknown>;
					if (content.via && Array.isArray(content.via)) {
						if (
							suggestedOnly &&
							!(content as Record<string, unknown>).suggested
						)
							continue;
						cChildrenState.push({
							content: event.content,
							sender: event.sender,
							state_key: event.state_key ?? "",
							type: event.type,
						});
					}
				}
			}

			children.push({
				room_id: childId,
				name: cNameEvent
					? ((cNameEvent.content as Record<string, unknown>).name as string)
					: undefined,
				topic: cTopicEvent
					? ((cTopicEvent.content as Record<string, unknown>).topic as string)
					: undefined,
				avatar_url: cAvatarEvent
					? ((cAvatarEvent.content as Record<string, unknown>).url as string)
					: undefined,
				canonical_alias: cAliasEvent
					? ((cAliasEvent.content as Record<string, unknown>).alias as string)
					: undefined,
				num_joined_members: cMemberCount,
				world_readable: cHistVis === "world_readable",
				guest_can_join: cGuestAccess === "can_join",
				join_rule: cJoinRulesEvent
					? ((cJoinRulesEvent.content as Record<string, unknown>)
							.join_rule as string)
					: undefined,
				room_type: cCreateEvent
					? ((cCreateEvent.content as Record<string, unknown>).type as string)
					: undefined,
				children_state: cChildrenState,
				allowed_room_ids: [] as string[],
			});
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
