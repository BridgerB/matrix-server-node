import { createHash } from "node:crypto";
import { forbidden, notJoined, roomNotFound } from "./errors.ts";
import type { SigningKey } from "./signing.ts";
import { signEvent } from "./signing.ts";
import type { Storage } from "./storage/interface.ts";
import type { ClientEvent, PDU, UnsignedData } from "./types/events.ts";
import type { EventId, RoomId, ServerName, UserId } from "./types/index.ts";
import type { RoomState } from "./types/internal.ts";
import type { JsonObject } from "./types/json.ts";
import type { RoomPowerLevelsContent } from "./types/state-events.ts";
export const canonicalJson = (val: unknown): string => {
	if (val === null || val === undefined) return "null";
	if (typeof val === "boolean") return val ? "true" : "false";
	if (typeof val === "number") return JSON.stringify(val);
	if (typeof val === "string") return JSON.stringify(val);
	if (Array.isArray(val)) {
		return `[${val.map((v) => canonicalJson(v)).join(",")}]`;
	}
	if (typeof val === "object") {
		const keys = Object.keys(val as Record<string, unknown>).sort();
		const entries = keys.map(
			(k) =>
				`${JSON.stringify(k)}:${canonicalJson((val as Record<string, unknown>)[k])}`,
		);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(val);
};
const ALLOWED_TOP_LEVEL = new Set([
	"auth_events",
	"content",
	"depth",
	"hashes",
	"origin_server_ts",
	"prev_events",
	"room_id",
	"sender",
	"signatures",
	"state_key",
	"type",
]);

const ALLOWED_CONTENT_KEYS: Record<string, Set<string>> = {
	"m.room.create": new Set([
		"creator",
		"room_version",
		"type",
		"federate",
		"predecessor",
	]),
	"m.room.member": new Set([
		"membership",
		"join_authorised_via_users_server",
		"third_party_invite",
	]),
	"m.room.power_levels": new Set([
		"ban",
		"events",
		"events_default",
		"invite",
		"kick",
		"redact",
		"state_default",
		"users",
		"users_default",
	]),
	"m.room.join_rules": new Set(["join_rule", "allow"]),
	"m.room.history_visibility": new Set(["history_visibility"]),
	"m.room.redaction": new Set(["redacts"]),
};

export const redactEvent = (event: PDU): PDU => {
	const redacted: Record<string, unknown> = {};
	for (const key of ALLOWED_TOP_LEVEL) {
		if (key in event) {
			redacted[key] = (event as unknown as Record<string, unknown>)[key];
		}
	}

	const allowedKeys = ALLOWED_CONTENT_KEYS[event.type];
	redacted.content = allowedKeys
		? Object.fromEntries(
				[...allowedKeys]
					.filter((k) => k in event.content)
					.map((k) => [k, event.content[k]]),
			)
		: {};

	return redacted as unknown as PDU;
};
export const computeContentHash = (event: PDU): string => {
	const copy: Record<string, unknown> = { ...event };
	delete copy.unsigned;
	delete copy.signatures;
	delete copy.hashes;
	delete copy.event_id;
	return createHash("sha256").update(canonicalJson(copy)).digest("base64url");
};

export const computeEventId = (event: PDU): EventId => {
	const withHash: PDU = {
		...event,
		hashes: { sha256: computeContentHash(event) },
	};

	const redacted = redactEvent(withHash);
	const forRef: Record<string, unknown> = { ...redacted };
	delete forRef.unsigned;
	delete forRef.signatures;

	const hash = createHash("sha256")
		.update(canonicalJson(forRef))
		.digest("base64url");
	return `$${hash}`;
};
export const buildEvent = (params: {
	roomId: RoomId;
	sender: UserId;
	type: string;
	content: JsonObject;
	stateKey?: string;
	depth: number;
	prevEvents: EventId[];
	authEvents: EventId[];
	redacts?: EventId;
	unsigned?: UnsignedData;
	serverName: ServerName;
	signingKey?: SigningKey;
}): { event: PDU; eventId: EventId } => {
	const event: PDU = {
		auth_events: params.authEvents,
		content: params.content,
		depth: params.depth,
		hashes: { sha256: "" },
		origin_server_ts: Date.now(),
		prev_events: params.prevEvents,
		room_id: params.roomId,
		sender: params.sender,
		signatures: { [params.serverName]: {} },
		type: params.type,
	};

	if (params.stateKey !== undefined) {
		event.state_key = params.stateKey;
	}
	if (params.redacts) {
		event.redacts = params.redacts;
	}
	if (params.unsigned) {
		event.unsigned = params.unsigned;
	}

	event.hashes = { sha256: computeContentHash(event) };
	const eventId = computeEventId(event);

	if (params.signingKey) {
		return {
			event: signEvent(event, params.serverName, params.signingKey),
			eventId,
		};
	}

	return { event, eventId };
};
const getStateEventId = (
	roomState: RoomState,
	type: string,
	stateKey: string,
): EventId | undefined => {
	const event = roomState.state_events.get(makeStateKey(type, stateKey));
	return event ? computeEventId(event) : undefined;
};

export const selectAuthEvents = (
	eventType: string,
	stateKey: string | undefined,
	roomState: RoomState,
	sender: UserId,
): EventId[] => {
	const authEvents: EventId[] = [];

	const createId = getStateEventId(roomState, "m.room.create", "");
	if (createId) authEvents.push(createId);

	const plId = getStateEventId(roomState, "m.room.power_levels", "");
	if (plId) authEvents.push(plId);

	const senderMemberId = getStateEventId(roomState, "m.room.member", sender);
	if (senderMemberId) authEvents.push(senderMemberId);

	if (eventType === "m.room.member" && stateKey) {
		const joinRulesId = getStateEventId(roomState, "m.room.join_rules", "");
		if (joinRulesId) authEvents.push(joinRulesId);

		if (stateKey !== sender) {
			const targetMemberId = getStateEventId(
				roomState,
				"m.room.member",
				stateKey,
			);
			if (targetMemberId) authEvents.push(targetMemberId);
		}
	}

	return authEvents;
};
export const getPowerLevels = (
	roomState: RoomState,
): RoomPowerLevelsContent => {
	const plEvent = roomState.state_events.get("m.room.power_levels\0");
	return plEvent
		? (plEvent.content as unknown as RoomPowerLevelsContent)
		: { users_default: 0, events_default: 0, state_default: 50 };
};

export const getUserPowerLevel = (
	userId: UserId,
	roomState: RoomState,
): number => {
	const plEvent = roomState.state_events.get("m.room.power_levels\0");
	if (!plEvent) {
		// Before power_levels is set, the room creator has implicit PL 100
		const createEvent = roomState.state_events.get("m.room.create\0");
		if (createEvent && createEvent.sender === userId) return 100;
		return 0;
	}
	const pl = plEvent.content as unknown as RoomPowerLevelsContent;
	return pl.users?.[userId] ?? pl.users_default ?? 0;
};

const getEventPowerLevel = (
	eventType: string,
	isState: boolean,
	roomState: RoomState,
): number => {
	const pl = getPowerLevels(roomState);
	if (pl.events?.[eventType] !== undefined)
		return pl.events[eventType] as number;
	return isState ? (pl.state_default ?? 50) : (pl.events_default ?? 0);
};
export const getMembership = (
	roomState: RoomState,
	userId: UserId,
): string | undefined => {
	const memberEvent = roomState.state_events.get(`m.room.member\0${userId}`);
	return (memberEvent?.content as Record<string, unknown> | undefined)
		?.membership as string | undefined;
};

const checkMembershipAuth = (event: PDU, roomState: RoomState): void => {
	const targetUserId = event.state_key as string;
	const membership = (event.content as Record<string, unknown>)
		.membership as string;
	const senderMembership = getMembership(roomState, event.sender);
	const targetMembership = getMembership(roomState, targetUserId);
	const pl = getPowerLevels(roomState);
	const senderPl = getUserPowerLevel(event.sender, roomState);

	switch (membership) {
		case "join": {
			if (event.sender !== targetUserId) {
				throw forbidden("Cannot force another user to join");
			}
			if (senderMembership === "ban") {
				throw forbidden("User is banned from the room");
			}
			if (senderMembership === "join") return;
			if (senderMembership === "invite") return;

			const createEvent = roomState.state_events.get("m.room.create\0");
			if (
				createEvent &&
				createEvent.sender === event.sender &&
				!senderMembership
			) {
				return;
			}

			const joinRulesEvent = roomState.state_events.get("m.room.join_rules\0");
			const joinRule = joinRulesEvent
				? ((joinRulesEvent.content as Record<string, unknown>)
						.join_rule as string)
				: "invite";

			if (joinRule === "public") return;
			throw forbidden("Room is invite-only");
		}

		case "invite": {
			if (senderMembership !== "join") {
				throw forbidden("Sender is not in the room");
			}
			if (targetMembership === "ban") {
				throw forbidden("Cannot invite banned user");
			}
			const invitePl = pl.invite ?? 0;
			if (senderPl < invitePl) {
				throw forbidden(
					`Insufficient power level to invite: need ${invitePl}, have ${senderPl}`,
				);
			}
			return;
		}

		case "leave": {
			if (event.sender === targetUserId) {
				if (senderMembership === "join" || senderMembership === "invite")
					return;
				throw forbidden("Cannot leave a room you are not in");
			}
			if (senderMembership !== "join") {
				throw forbidden("Sender is not in the room");
			}
			const kickPl = pl.kick ?? 50;
			if (senderPl < kickPl) {
				throw forbidden(
					`Insufficient power level to kick: need ${kickPl}, have ${senderPl}`,
				);
			}
			const targetPl = getUserPowerLevel(targetUserId, roomState);
			if (senderPl <= targetPl) {
				throw forbidden("Cannot kick user with equal or higher power level");
			}
			return;
		}

		case "ban": {
			if (senderMembership !== "join") {
				throw forbidden("Sender is not in the room");
			}
			const banPl = pl.ban ?? 50;
			if (senderPl < banPl) {
				throw forbidden(
					`Insufficient power level to ban: need ${banPl}, have ${senderPl}`,
				);
			}
			if (targetUserId !== event.sender) {
				const targetPl = getUserPowerLevel(targetUserId, roomState);
				if (senderPl <= targetPl) {
					throw forbidden("Cannot ban user with equal or higher power level");
				}
			}
			return;
		}

		default:
			throw forbidden(`Unknown membership: ${membership}`);
	}
};

export const checkEventAuth = (
	event: PDU,
	_eventId: EventId,
	roomState: RoomState,
): void => {
	if (event.type === "m.room.create") {
		if (roomState.state_events.size > 0) {
			throw forbidden("m.room.create can only be the first event");
		}
		return;
	}

	if (event.type === "m.room.member") {
		checkMembershipAuth(event, roomState);
		return;
	}

	const senderMembership = getMembership(roomState, event.sender);
	if (senderMembership !== "join") {
		throw forbidden("Sender is not in the room");
	}

	const isState = event.state_key !== undefined;
	const requiredPl = getEventPowerLevel(event.type, isState, roomState);
	const senderPl = getUserPowerLevel(event.sender, roomState);
	if (senderPl < requiredPl) {
		throw forbidden(
			`Insufficient power level: need ${requiredPl}, have ${senderPl}`,
		);
	}
};
export const pduToClientEvent = (pdu: PDU, eventId: EventId): ClientEvent => {
	const ce: ClientEvent = {
		content: pdu.content,
		event_id: eventId,
		origin_server_ts: pdu.origin_server_ts,
		room_id: pdu.room_id,
		sender: pdu.sender,
		type: pdu.type,
	};
	if (pdu.state_key !== undefined) ce.state_key = pdu.state_key;
	if (pdu.unsigned) ce.unsigned = pdu.unsigned;
	if (pdu.redacts) ce.redacts = pdu.redacts;
	return ce;
};

export const requireJoinedRoom = async (
	storage: Storage,
	roomId: string,
	userId: string,
): Promise<RoomState> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw roomNotFound();
	if (getMembership(room, userId) !== "join") throw notJoined();
	return room;
};

export const countJoinedMembers = (
	stateEvents: Map<string, { content: unknown }>,
): number =>
	[...stateEvents.entries()].filter(
		([key, event]) =>
			key.startsWith("m.room.member\0") &&
			(event.content as Record<string, unknown>).membership === "join",
	).length;

export const getStateContent = (
	stateEvents: Map<string, { content: unknown }>,
	key: string,
	field: string,
): string | undefined => {
	const event = stateEvents.get(key);
	return event
		? ((event.content as Record<string, unknown>)[field] as string | undefined)
		: undefined;
};

export const makeStateKey = (type: string, stateKey = ""): string =>
	`${type}\0${stateKey}`;

export interface EventContext {
	roomState: RoomState;
	depth: number;
	prevEvents: string[];
}

export const sendStateEvent = async (
	storage: Storage,
	serverName: string,
	ctx: EventContext,
	sender: string,
	type: string,
	stateKey: string,
	content: JsonObject,
): Promise<string> => {
	const authEvents = selectAuthEvents(type, stateKey, ctx.roomState, sender);
	const { event, eventId } = buildEvent({
		roomId: ctx.roomState.room_id,
		sender,
		type,
		content,
		stateKey,
		depth: ctx.depth,
		prevEvents: ctx.prevEvents,
		authEvents,
		serverName,
	});

	checkEventAuth(event, eventId, ctx.roomState);
	await storage.setStateEvent(ctx.roomState.room_id, event, eventId);

	ctx.depth++;
	ctx.prevEvents = [eventId];
	ctx.roomState.depth = ctx.depth;
	ctx.roomState.forward_extremities = [eventId];

	return eventId;
};
