import { forbidden, notFound, unableToAuthoriseJoin } from "../../errors.ts";
import {
	checkEventAuth,
	computeEventId,
	getMembership,
	selectAuthEvents,
} from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { FederationClient } from "../../federation/client.ts";
import type { RemoteKeyStore } from "../../federation/key-store.ts";
import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import { signEvent, verifyEventSignature } from "../../signing.ts";
import type { Storage } from "../../storage/interface.ts";
import type { PDU } from "../../types/events.ts";
import type { KeyId, RoomId, ServerName, UserId } from "../../types/index.ts";

const verifyOriginSignature = async (
	event: PDU,
	origin: string,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
) => {
	const originSigs = event.signatures?.[origin];
	if (!originSigs) throw forbidden("No signature from origin");

	for (const keyId of Object.keys(originSigs)) {
		const pubKey = await remoteKeyStore.getServerKey(
			origin,
			keyId as KeyId,
			federationClient,
		);
		if (pubKey && verifyEventSignature(event, origin, keyId as KeyId, pubKey))
			return;
	}
	throw forbidden("Invalid event signature");
};
export function getMakeJoin(storage: Storage, _serverName: string): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.params.userId as UserId;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		const createContent = room.state_events.get("m.room.create\0")?.content as
			| Record<string, unknown>
			| undefined;
		if (createContent?.federate === false)
			throw forbidden("Room does not federate");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
		const joinRule = joinRulesEvent
			? ((joinRulesEvent.content as Record<string, unknown>)
					.join_rule as string)
			: "invite";

		const currentMembership = getMembership(room, userId);
		if (currentMembership === "ban") throw forbidden("User is banned");

		if (joinRule !== "public" && currentMembership !== "invite")
			throw unableToAuthoriseJoin("Room is not public and user is not invited");

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
export function putSendJoin(
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const event = req.body as PDU;
		const origin = req.origin as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		await verifyOriginSignature(
			event,
			origin,
			remoteKeyStore,
			federationClient,
		);

		const eventId = computeEventId(event);
		checkEventAuth(event, eventId, room);

		const coSigned = signEvent(event, serverName as ServerName, signingKey);
		await storage.setStateEvent(roomId, coSigned, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		const stateEvents = [...room.state_events.values()];
		const authEventIds = stateEvents.flatMap((se) => se.auth_events);
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
export function getMakeLeave(storage: Storage, _serverName: string): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.params.userId as UserId;

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
export function putSendLeave(
	storage: Storage,
	_serverName: string,
	_signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const event = req.body as PDU;
		const origin = req.origin as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		await verifyOriginSignature(
			event,
			origin,
			remoteKeyStore,
			federationClient,
		);

		const eventId = computeEventId(event);
		checkEventAuth(event, eventId, room);

		await storage.setStateEvent(roomId, event, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		return { status: 200, body: {} };
	};
}
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

		const { event } = body;
		const origin = req.origin as string;

		const targetServer = (event.state_key as string)
			.split(":")
			.slice(1)
			.join(":");
		if (targetServer !== serverName)
			throw forbidden("Invited user is not on this server");

		await verifyOriginSignature(
			event,
			origin,
			remoteKeyStore,
			federationClient,
		);

		const coSigned = signEvent(event, serverName as ServerName, signingKey);
		const eventId = computeEventId(coSigned);

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
