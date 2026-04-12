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
	computeEventId,
	computeRoomIdV12,
	type EventContext,
	getMembership,
	isRoomVersion12Plus,
	sendStateEvent,
} from "../events.ts";
import type { FederationClient } from "../federation/client.ts";

import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import { signEvent } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type { EventId, RoomId, ServerName } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";
import type { JsonObject } from "../types/json.ts";
import type { CreateRoomRequest } from "../types/room-operations.ts";
import type { RoomVersion } from "../types/room-versions.ts";
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
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
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

		const userId = req.userId as string;

		// Check if room exists locally
		const room = await storage.getRoom(roomId);
		if (room) {
			// Local join
			await sendMembershipEvent(
				storage,
				serverName,
				roomId,
				userId,
				userId,
				"join",
			);
			return { status: 200, body: { room_id: roomId } };
		}

		// Room not found locally — attempt federation join if we have federation capabilities
		if (!signingKey || !federationClient) {
			throw roomNotFound();
		}

		// Determine the remote server to contact
		// 1. Check server_name query parameter (Complement passes this)
		// 2. Extract from room ID
		const serverNameParams = req.query.getAll("server_name");
		const roomServer = roomId.includes(":")
			? roomId.split(":").slice(1).join(":")
			: undefined;

		const serversToTry: string[] = [];
		if (serverNameParams.length > 0) {
			serversToTry.push(...serverNameParams);
		}
		if (roomServer && !serversToTry.includes(roomServer)) {
			serversToTry.push(roomServer);
		}

		if (serversToTry.length === 0) {
			throw roomNotFound();
		}

		let lastError: unknown;
		for (const remoteServer of serversToTry) {
			try {
				const result = await performFederationJoin(
					storage,
					serverName,
					signingKey,
					federationClient,
					remoteServer as ServerName,
					roomId as RoomId,
					userId,
				);
				return result;
			} catch (err) {
				lastError = err;
			}
		}

		// All servers failed
		if (lastError instanceof Error) throw lastError;
		throw roomNotFound();
	};

const performFederationJoin = async (
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	federationClient: FederationClient,
	remoteServer: ServerName,
	roomId: RoomId,
	userId: string,
): Promise<{ status: number; body: { room_id: string } }> => {
	// 1. make_join — get a join event template from the remote server
	const makeJoinResp = await federationClient.request(
		remoteServer,
		"GET",
		`/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
	);

	if (makeJoinResp.status !== 200) {
		const respBody = makeJoinResp.body as Record<string, unknown> | undefined;
		throw new Error(
			`make_join failed: ${respBody?.error ?? respBody?.errcode ?? `status ${makeJoinResp.status}`}`,
		);
	}

	const makeJoinBody = makeJoinResp.body as {
		room_version?: string;
		event?: PDU;
	};
	const template = makeJoinBody.event;
	if (!template) throw new Error("make_join response missing event template");

	const roomVersion = (makeJoinBody.room_version ?? "10") as RoomVersion;

	// 2. Fill in the template and sign it
	template.origin_server_ts = Date.now();

	// Sign the event (this computes content hash and signs)
	const signedEvent = signEvent(
		template,
		serverName as ServerName,
		signingKey,
	);
	const eventId = computeEventId(signedEvent);

	// 3. send_join — send the signed event to the remote server
	const sendJoinResp = await federationClient.request(
		remoteServer,
		"PUT",
		`/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`,
		signedEvent,
	);

	if (sendJoinResp.status !== 200) {
		const respBody = sendJoinResp.body as Record<string, unknown> | undefined;
		throw new Error(
			`send_join failed: ${respBody?.error ?? respBody?.errcode ?? `status ${sendJoinResp.status}`}`,
		);
	}

	const sendJoinBody = sendJoinResp.body as {
		state?: PDU[];
		auth_chain?: PDU[];
		event?: PDU;
	};

	const stateEvents = sendJoinBody.state ?? [];
	const authChain = sendJoinBody.auth_chain ?? [];

	// 4. Import the room state
	// Include our join event in the state
	const allState = [...stateEvents, sendJoinBody.event ?? signedEvent];
	await storage.importRoomState(
		roomId,
		roomVersion,
		allState,
		authChain,
	);

	// Update the room's forward extremities and depth to include our join
	const room = await storage.getRoom(roomId);
	if (room) {
		room.forward_extremities = [eventId as EventId];
		room.depth = Math.max(room.depth, signedEvent.depth + 1);
	}

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
