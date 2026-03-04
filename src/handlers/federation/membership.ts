import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { SigningKey } from "../../signing.ts";
import type { RemoteKeyStore } from "../../federation/key-store.ts";
import type { FederationClient } from "../../federation/client.ts";
import type { PDU } from "../../types/events.ts";
import type {
	RoomId,
	UserId,
	EventId,
	ServerName,
	KeyId,
} from "../../types/index.ts";
import {
	computeEventId,
	selectAuthEvents,
	checkEventAuth,
	getMembership,
} from "../../events.ts";
import { signEvent, verifyEventSignature } from "../../signing.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import { forbidden, notFound, unableToAuthoriseJoin } from "../../errors.ts";

// =============================================================================
// GET /_matrix/federation/v1/make_join/:roomId/:userId
// =============================================================================

export function getMakeJoin(storage: Storage, _serverName: string): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]! as RoomId;
		const userId = req.params["userId"]! as UserId;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		// Check if federation is allowed
		const createEvent = room.state_events.get("m.room.create\0");
		if (createEvent) {
			const federate = (createEvent.content as Record<string, unknown>)[
				"federate"
			];
			if (federate === false) throw forbidden("Room does not federate");
		}

		// Check ACL
		if (!isServerAllowedByAcl(req.origin! as ServerName, room)) {
			throw forbidden("Server is denied by ACL");
		}

		// Check join rules
		const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
		const joinRule = joinRulesEvent
			? ((joinRulesEvent.content as Record<string, unknown>)[
					"join_rule"
				] as string)
			: "invite";

		const currentMembership = getMembership(room, userId);
		if (currentMembership === "ban") throw forbidden("User is banned");

		if (joinRule !== "public" && currentMembership !== "invite") {
			throw unableToAuthoriseJoin("Room is not public and user is not invited");
		}

		// Build join template
		const authEvents = selectAuthEvents("m.room.member", userId, room, userId);

		const template: Partial<PDU> = {
			auth_events: authEvents,
			content: { membership: "join" },
			depth: room.depth,
			origin_server_ts: Date.now(),
			prev_events: [...room.forward_extremities],
			room_id: roomId,
			sender: userId,
			state_key: userId,
			type: "m.room.member",
		};

		return {
			status: 200,
			body: {
				room_version: room.room_version,
				event: template,
			},
		};
	};
}

// =============================================================================
// PUT /_matrix/federation/v2/send_join/:roomId/:eventId
// =============================================================================

export function putSendJoin(
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]! as RoomId;
		const event = req.body as PDU;
		const origin = req.origin!;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		// Verify event signature from origin
		const originSigs = event.signatures?.[origin];
		if (!originSigs) throw forbidden("No signature from origin");

		let sigValid = false;
		for (const keyId of Object.keys(originSigs)) {
			const pubKey = await remoteKeyStore.getServerKey(
				origin,
				keyId as KeyId,
				federationClient,
			);
			if (
				pubKey &&
				verifyEventSignature(event, origin, keyId as KeyId, pubKey)
			) {
				sigValid = true;
				break;
			}
		}
		if (!sigValid) throw forbidden("Invalid event signature");

		// Verify event ID
		const eventId = computeEventId(event);

		// Auth check
		checkEventAuth(event, eventId, room);

		// Co-sign the event
		const coSigned = signEvent(event, serverName as ServerName, signingKey);

		// Store the event
		await storage.setStateEvent(roomId, coSigned, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		// Build response with full state + auth chain
		const stateEvents = [...room.state_events.values()];
		const authEventIds: EventId[] = [];
		for (const se of stateEvents) {
			for (const id of se.auth_events) authEventIds.push(id);
		}
		const authChain = await storage.getAuthChain(authEventIds);
		const servers = await storage.getServersInRoom(roomId);

		return {
			status: 200,
			body: {
				origin: serverName,
				auth_chain: authChain,
				state: stateEvents,
				event: coSigned,
				servers_in_room: servers,
				members_omitted: false,
			},
		};
	};
}

// =============================================================================
// GET /_matrix/federation/v1/make_leave/:roomId/:userId
// =============================================================================

export function getMakeLeave(storage: Storage, _serverName: string): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]! as RoomId;
		const userId = req.params["userId"]! as UserId;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		const currentMembership = getMembership(room, userId);
		if (currentMembership !== "join" && currentMembership !== "invite") {
			throw forbidden("User is not in the room");
		}

		const authEvents = selectAuthEvents("m.room.member", userId, room, userId);

		const template: Partial<PDU> = {
			auth_events: authEvents,
			content: { membership: "leave" },
			depth: room.depth,
			origin_server_ts: Date.now(),
			prev_events: [...room.forward_extremities],
			room_id: roomId,
			sender: userId,
			state_key: userId,
			type: "m.room.member",
		};

		return {
			status: 200,
			body: {
				room_version: room.room_version,
				event: template,
			},
		};
	};
}

// =============================================================================
// PUT /_matrix/federation/v2/send_leave/:roomId/:eventId
// =============================================================================

export function putSendLeave(
	storage: Storage,
	_serverName: string,
	_signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]! as RoomId;
		const event = req.body as PDU;
		const origin = req.origin!;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		// Verify signature
		const originSigs = event.signatures?.[origin];
		if (!originSigs) throw forbidden("No signature from origin");

		let sigValid = false;
		for (const keyId of Object.keys(originSigs)) {
			const pubKey = await remoteKeyStore.getServerKey(
				origin,
				keyId as KeyId,
				federationClient,
			);
			if (
				pubKey &&
				verifyEventSignature(event, origin, keyId as KeyId, pubKey)
			) {
				sigValid = true;
				break;
			}
		}
		if (!sigValid) throw forbidden("Invalid event signature");

		const eventId = computeEventId(event);
		checkEventAuth(event, eventId, room);

		await storage.setStateEvent(roomId, event, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		return { status: 200, body: {} };
	};
}

// =============================================================================
// PUT /_matrix/federation/v2/invite/:roomId/:eventId
// =============================================================================

export function putFederationInvite(
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const body = req.body as {
			room_version?: string;
			event: PDU;
			invite_room_state?: unknown[];
		};

		const event = body.event;
		const origin = req.origin!;

		// Verify the invited user is local
		const targetUserId = event.state_key!;
		const targetServer = targetUserId.split(":").slice(1).join(":");
		if (targetServer !== serverName) {
			throw forbidden("Invited user is not on this server");
		}

		// Verify signature from origin
		const originSigs = event.signatures?.[origin];
		if (!originSigs) throw forbidden("No signature from origin");

		let sigValid = false;
		for (const keyId of Object.keys(originSigs)) {
			const pubKey = await remoteKeyStore.getServerKey(
				origin,
				keyId as KeyId,
				federationClient,
			);
			if (
				pubKey &&
				verifyEventSignature(event, origin, keyId as KeyId, pubKey)
			) {
				sigValid = true;
				break;
			}
		}
		if (!sigValid) throw forbidden("Invalid event signature");

		// Co-sign the event
		const coSigned = signEvent(event, serverName as ServerName, signingKey);
		const eventId = computeEventId(coSigned);

		// Store the invite - create room state if we don't have it
		const room = await storage.getRoom(event.room_id);
		if (!room) {
			await storage.importRoomState(
				event.room_id,
				(body.room_version ??
					"10") as import("../../types/room-versions.ts").RoomVersion,
				[coSigned],
				[],
			);
		} else {
			await storage.setStateEvent(event.room_id, coSigned, eventId);
			room.depth = Math.max(room.depth, event.depth + 1);
			room.forward_extremities = [eventId];
		}

		return {
			status: 200,
			body: { event: coSigned },
		};
	};
}
