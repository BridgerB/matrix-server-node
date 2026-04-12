import { generateRoomId } from "../crypto.ts";
import {
	badJson,
	forbidden,
	missingParam,
	notFound,
	roomNotFound,
} from "../errors.ts";
import {
	buildEvent,
	computeRoomIdV12,
	type EventContext,
	getMembership,
	isRoomVersion12Plus,
	sendStateEvent,
} from "../events.ts";

import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";
import type { JsonObject } from "../types/json.ts";
import type { CreateRoomRequest } from "../types/room-operations.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
export const postCreateRoom =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as CreateRoomRequest;
		const userId = req.userId as string;
		const roomVersion = body.room_version ?? "11";
		const v12Plus = isRoomVersion12Plus(roomVersion);

		let roomId: string;

		const preset =
			body.preset ??
			(body.visibility === "public" ? "public_chat" : "private_chat");

		const createContent: JsonObject = {
			room_version: roomVersion,
			...body.creation_content,
		};

		if (v12Plus) {
			// Validate additional_creators
			const additionalCreators = createContent.additional_creators as
				| string[]
				| undefined;
			if (additionalCreators) {
				for (const uid of additionalCreators) {
					if (
						typeof uid !== "string" ||
						!uid.startsWith("@") ||
						!uid.includes(":")
					) {
						throw badJson(`Invalid user ID in additional_creators: ${uid}`);
					}
				}
			}

			// For v12, we need to compute the room ID from the create event hash.
			// Build a temporary create event with a placeholder room_id to compute the hash.
			const tempRoomId = "!placeholder:temp" as RoomId;
			const { event: tempCreateEvent } = buildEvent({
				roomId: tempRoomId,
				sender: userId,
				type: "m.room.create",
				content: createContent,
				stateKey: "",
				depth: 0,
				prevEvents: [],
				authEvents: [],
				serverName,
			});
			// Remove room_id from the temp event before hashing for v12
			const createForHash = { ...tempCreateEvent };
			delete (createForHash as Record<string, unknown>).room_id;
			roomId = computeRoomIdV12(createForHash);
		} else {
			roomId = generateRoomId(serverName);
		}

		const roomState: RoomState = {
			room_id: roomId,
			room_version: roomVersion,
			state_events: new Map(),
			depth: 0,
			forward_extremities: [],
		};
		await storage.createRoom(roomState);

		const ctx: EventContext = { roomState, depth: 0, prevEvents: [] };

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.create",
			"",
			createContent,
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.member",
			userId,
			{ membership: "join" },
		);

		// In v12+, room creators have infinite power level implicitly,
		// so they must NOT appear in the users field of m.room.power_levels
		const plContent: RoomPowerLevelsContent = v12Plus
			? {
					users: {},
					users_default: 0,
					events_default: 0,
					state_default: 50,
					ban: 50,
					kick: 50,
					redact: 50,
					invite: 0,
					events: {
						"m.room.name": 50,
						"m.room.power_levels": 100,
						"m.room.history_visibility": 100,
						"m.room.canonical_alias": 50,
						"m.room.avatar": 50,
						"m.room.tombstone": 150,
						"m.room.server_acl": 100,
						"m.room.encryption": 100,
					},
				}
			: {
					users: { [userId]: 100 },
					users_default: 0,
					events_default: 0,
					state_default: 50,
					ban: 50,
					kick: 50,
					redact: 50,
					invite: 0,
					events: {
						"m.room.name": 50,
						"m.room.power_levels": 100,
						"m.room.history_visibility": 100,
						"m.room.canonical_alias": 50,
						"m.room.avatar": 50,
						"m.room.tombstone": 100,
						"m.room.server_acl": 100,
						"m.room.encryption": 100,
					},
				};
		if (preset === "trusted_private_chat" && body.invite) {
			for (const invitee of body.invite) {
				// In v12+, don't add room creators to users field
				if (v12Plus) {
					const additionalCreators = (createContent.additional_creators ??
						[]) as string[];
					if (invitee === userId || additionalCreators.includes(invitee))
						continue;
				}
				(plContent.users as Record<string, number>)[invitee] = 100;
			}
		}
		if (body.power_level_content_override) {
			// In v12+, strip room creators from the override users field
			if (v12Plus && body.power_level_content_override.users) {
				const overrideUsers = { ...body.power_level_content_override.users };
				delete overrideUsers[userId as string];
				const additionalCreators = (createContent.additional_creators ??
					[]) as string[];
				for (const uid of additionalCreators) {
					delete overrideUsers[uid as string];
				}
				body.power_level_content_override = {
					...body.power_level_content_override,
					users: overrideUsers,
				};
			}
			Object.assign(plContent, body.power_level_content_override);
		}
		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.power_levels",
			"",
			plContent as unknown as JsonObject,
		);

		const joinRule = preset === "public_chat" ? "public" : "invite";
		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.join_rules",
			"",
			{
				join_rule: joinRule,
			},
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.history_visibility",
			"",
			{
				history_visibility: "shared",
			},
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.guest_access",
			"",
			{
				guest_access: "forbidden",
			},
		);

		if (body.initial_state) {
			for (const stateInput of body.initial_state) {
				await sendStateEvent(
					storage,
					serverName,
					ctx,
					userId,
					stateInput.type,
					stateInput.state_key ?? "",
					stateInput.content,
				);
			}
		}

		if (body.name) {
			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				"m.room.name",
				"",
				{
					name: body.name,
				},
			);
		}

		if (body.topic) {
			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				"m.room.topic",
				"",
				{
					topic: body.topic,
				},
			);
		}

		if (body.invite) {
			for (const invitee of body.invite) {
				await sendStateEvent(
					storage,
					serverName,
					ctx,
					userId,
					"m.room.member",
					invitee,
					{
						membership: "invite",
					},
				);
			}
		}

		if (body.room_alias_name) {
			const roomAlias = `#${body.room_alias_name}:${serverName}`;
			const existing = await storage.getRoomByAlias(roomAlias);
			if (existing) throw badJson(`Room alias ${roomAlias} already exists`);
			await storage.createRoomAlias(roomAlias, roomId, [serverName], userId);
			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				"m.room.canonical_alias",
				"",
				{
					alias: roomAlias,
				},
			);
		}

		if (body.visibility === "public") {
			await storage.setRoomVisibility(roomId, "public");
		}

		return { status: 200, body: { room_id: roomId } };
	};
export const getJoinedRooms =
	(storage: Storage): Handler =>
	async (req) => {
		const rooms = await storage.getRoomsForUser(req.userId as string);
		return { status: 200, body: { joined_rooms: rooms } };
	};
const sendMembershipEvent = async (
	storage: Storage,
	serverName: string,
	roomId: string,
	sender: string,
	targetUserId: string,
	membership: string,
	reason?: string,
): Promise<string> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw roomNotFound();

	const content: JsonObject = { membership };
	if (reason) content.reason = reason;

	const ctx: EventContext = {
		roomState: room,
		depth: room.depth,
		prevEvents: [...room.forward_extremities],
	};

	return sendStateEvent(
		storage,
		serverName,
		ctx,
		sender,
		"m.room.member",
		targetUserId,
		content,
	);
};

export const postJoin =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomIdOrAlias = req.params.roomIdOrAlias ?? req.params.roomId;
		if (!roomIdOrAlias) throw badJson("Missing room ID or alias");

		let roomId: string;
		if (roomIdOrAlias.startsWith("#")) {
			const resolved = await storage.getRoomByAlias(roomIdOrAlias);
			if (!resolved) throw notFound(`Room alias ${roomIdOrAlias} not found`);
			roomId = resolved.room_id;
		} else {
			roomId = roomIdOrAlias;
		}

		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			req.userId as string,
			"join",
		);
		return { status: 200, body: { room_id: roomId } };
	};

export const postLeave =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = (req.body ?? {}) as { reason?: string };
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			req.userId as string,
			"leave",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postInvite =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = req.body as { user_id?: string; reason?: string } | undefined;
		if (!body?.user_id) throw missingParam("Missing 'user_id'");
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			body.user_id,
			"invite",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postKnock =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = (req.body ?? {}) as { reason?: string };
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			req.userId as string,
			"knock",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postKick =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = req.body as { user_id?: string; reason?: string } | undefined;
		if (!body?.user_id) throw missingParam("Missing 'user_id'");
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			body.user_id,
			"leave",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postBan =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = req.body as { user_id?: string; reason?: string } | undefined;
		if (!body?.user_id) throw missingParam("Missing 'user_id'");
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			body.user_id,
			"ban",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postUnban =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = req.body as { user_id?: string; reason?: string } | undefined;
		if (!body?.user_id) throw missingParam("Missing 'user_id'");

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		const currentMembership = getMembership(room, body.user_id);
		if (currentMembership !== "ban") throw forbidden("User is not banned");

		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			body.user_id,
			"leave",
			body.reason,
		);
		return { status: 200, body: {} };
	};

export const postForget =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const userId = req.userId as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();

		const membership = getMembership(room, userId);
		if (membership !== "leave" && membership !== "ban") {
			throw forbidden("User must have left the room before forgetting it");
		}

		return { status: 200, body: {} };
	};
