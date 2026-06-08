import { createHash } from "node:crypto";
import { badJson, forbidden, notJoined, roomNotFound } from "./errors.ts";
import type { FederationClient } from "./federation/client.ts";
import { fanoutEvent } from "./federation/outbound.ts";
import type { SigningKey } from "./signing.ts";
import { signEvent } from "./signing.ts";
import type { Storage } from "./storage/interface.ts";
import type { ClientEvent, PDU, UnsignedData } from "./types/events.ts";
import type { EventId, RoomId, ServerName, UserId } from "./types/index.ts";
import type { RoomState } from "./types/internal.ts";
import type { JsonObject } from "./types/json.ts";
import type { RoomPowerLevelsContent } from "./types/state-events.ts";

/**
 * MSC4289: power level assigned to room creators. Matches Synapse's
 * `CREATOR_POWER_LEVEL = 2**53`, which is strictly greater than the largest
 * value representable in canonical JSON (`2**53 - 1`). This guarantees creators
 * outrank every settable power level, so non-creators can never kick/ban/demote
 * them, while creators can act on anyone.
 */
export const CREATOR_POWER_LEVEL = 2 ** 53;

/**
 * Largest/smallest integers representable in canonical JSON (Synapse's
 * `CANONICALJSON_MAX_INT`/`CANONICALJSON_MIN_INT`, i.e. `±(2**53 - 1)`).
 * Power-level values outside this range are rejected.
 */
const CANONICALJSON_MAX_INT = 2 ** 53 - 1;
const CANONICALJSON_MIN_INT = -(2 ** 53 - 1);

/** Check whether a room version is v12 or later */
export const isRoomVersion12Plus = (roomVersion: string | undefined): boolean => {
	if (!roomVersion) return false;
	const num = parseInt(roomVersion, 10);
	return !isNaN(num) && num >= 12;
};

/**
 * MSC3757 (owned state events).
 *
 * Opt-in is gated on the room version. The MSC's unstable room version is
 * `org.matrix.msc3757.<base version>` (the Complement test uses
 * `org.matrix.msc3757.10`). This mirrors Synapse's `msc3757_enabled` flag on
 * its `MSC3757v10` room version. Stable numeric versions (e.g. "10") do NOT
 * opt in, so `TestWithoutOwnedState` still enforces normal power levels and the
 * "cannot set others' state" restriction without the bypass.
 */
const isMsc3757Enabled = (roomVersion: string | undefined): boolean =>
	roomVersion?.startsWith("org.matrix.msc3757.") ?? false;

// Synapse VALID_HOST_REGEX: \A[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*\Z
const VALID_HOST_REGEX = /^[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*$/;

/**
 * Validate that `s` is a syntactically valid user ID (`@localpart:server`),
 * matching the subset of Synapse's `UserID.is_valid` relevant to MSC3757 owned
 * state-key parsing. Returns false for things like `@oops` (no colon) or a
 * server part with invalid characters (e.g. `hs1@state`).
 */
const isValidUserId = (s: string): boolean => {
	if (s.length < 1 || s[0] !== "@") return false;
	const colon = s.indexOf(":");
	if (colon === -1) return false;
	const domain = s.slice(colon + 1);
	// Strip optional :port (server names may include a port).
	const portIdx = domain.lastIndexOf(":");
	const host = portIdx === -1 ? domain : domain.slice(0, portIdx);
	// IPv6 literals are wrapped in [...]; accept them as-is.
	if (host.length > 0 && host[host.length - 1] === "]") return true;
	return VALID_HOST_REGEX.test(host);
};
/**
 * MSC4289 `check_valid_additional_creators`. The `additional_creators` field of
 * an `m.room.create` event (and the `/upgrade` request) must be an array of
 * syntactically valid user-ID strings, each at most 255 bytes. Mismatches raise
 * `M_BAD_JSON` (HTTP 400), matching Synapse's `AuthError(400, ...)`.
 *
 * Exported so the createRoom / upgrade handlers can reuse the exact same
 * validation before building the create event.
 */
export const validateAdditionalCreators = (value: unknown): void => {
	if (!Array.isArray(value)) {
		throw badJson("additional_creators must be an array");
	}
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw badJson("entry in additional_creators is not a string");
		}
		if (!isValidUserId(entry)) {
			throw badJson("entry in additional_creators is not a valid user ID");
		}
		if (entry.length > 255 || Buffer.byteLength(entry, "utf-8") > 255) {
			throw badJson("entry in additional_creators too long");
		}
	}
};

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
		"additional_creators",
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
	// MSC4291: v12 create events have no room_id of their own, so it is not an
	// allowed redaction key for them (mirrors Synapse's prune_event, which drops
	// "room_id" from allowed_keys when msc4291_room_ids_as_hashes is set). This
	// keeps both the reference hash (event ID) and the signed form room_id-free.
	const stripRoomId = isV12CreateEvent(event);

	const redacted: Record<string, unknown> = {};
	for (const key of ALLOWED_TOP_LEVEL) {
		if (key === "room_id" && stripRoomId) continue;
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
/**
 * MSC4291: in room version 12+ the `m.room.create` event has no `room_id` of its
 * own — the room ID *is* the create event's reference hash, so including a
 * `room_id` field while hashing would be circular. Synapse handles this by never
 * putting a `room_id` on v12 create events. We allow the stored PDU to carry a
 * `room_id` (so CS-API responses can expose it), but strip it before computing
 * the content hash / reference hash so the create event's ID matches the room ID.
 *
 * Detection uses the event itself: a `m.room.create` whose `content.room_version`
 * is 12+. This keeps `computeContentHash`/`computeEventId` self-contained.
 */
const isV12CreateEvent = (event: { type: string; content: unknown }): boolean =>
	event.type === "m.room.create" &&
	isRoomVersion12Plus(
		(event.content as Record<string, unknown> | undefined)?.room_version as
			| string
			| undefined,
	);

export const computeContentHash = (event: PDU): string => {
	const copy: Record<string, unknown> = { ...event };
	delete copy.unsigned;
	delete copy.signatures;
	delete copy.hashes;
	delete copy.event_id;
	if (isV12CreateEvent(event)) delete copy.room_id;
	return createHash("sha256").update(canonicalJson(copy)).digest("base64url");
};

export const computeEventId = (event: PDU): EventId => {
	const withHash: PDU = {
		...event,
		hashes: { sha256: computeContentHash(event) },
	};

	// redactEvent already drops room_id for v12 create events (MSC4291), so the
	// create event's reference hash — and therefore its ID — equals the room ID.
	const redacted = redactEvent(withHash);
	const forRef: Record<string, unknown> = { ...redacted };
	delete forRef.unsigned;
	delete forRef.signatures;

	const hash = createHash("sha256")
		.update(canonicalJson(forRef))
		.digest("base64url");
	return `$${hash}`;
};
/**
 * Compute a room ID for room version 12+ from the create event.
 * The room ID is the event ID of the create event with `!` sigil instead of `$`.
 */
export const computeRoomIdV12 = (createEvent: PDU): RoomId => {
	const eventId = computeEventId(createEvent);
	return `!${eventId.slice(1)}` as RoomId;
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

	// In v12+, m.room.create is NOT included in auth_events
	if (!isRoomVersion12Plus(roomState.room_version)) {
		const createId = getStateEventId(roomState, "m.room.create", "");
		if (createId) authEvents.push(createId);
	}

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

/** Check if a user is a room creator (sender of create event or in additional_creators) */
export const isRoomCreator = (
	userId: UserId,
	roomState: RoomState,
): boolean => {
	const createEvent = roomState.state_events.get("m.room.create\0");
	if (!createEvent) return false;
	if (createEvent.sender === userId) return true;
	const additionalCreators = (createEvent.content as Record<string, unknown>)
		.additional_creators as string[] | undefined;
	return additionalCreators?.includes(userId) ?? false;
};

export const getUserPowerLevel = (
	userId: UserId,
	roomState: RoomState,
): number => {
	// In room version 12+, room creators have infinite power level (MSC4289).
	if (isRoomVersion12Plus(roomState.room_version) && isRoomCreator(userId, roomState)) {
		return CREATOR_POWER_LEVEL;
	}

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
	// In room version 12+, the default power level for m.room.tombstone is 150
	if (
		eventType === "m.room.tombstone" &&
		isRoomVersion12Plus(roomState.room_version)
	) {
		return 150;
	}
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

			if (joinRule === "restricted" || joinRule === "knock_restricted") {
				const joinAuth = (event.content as Record<string, unknown>)
					.join_authorised_via_users_server as string | undefined;
				if (joinAuth) {
					// Verify the authorizing user is actually joined to this room
					const authUserMembership = getMembership(roomState, joinAuth);
					if (authUserMembership !== "join") {
						throw forbidden(
							"Authorizing user is not a member of the room",
						);
					}
					return;
				}
				// Also allow if the user was previously knocked (accepted knock)
				if (senderMembership === "knock") return;
			}

			throw forbidden("Room is invite-only");
		}

		case "invite": {
			if (senderMembership !== "join") {
				throw forbidden("Sender is not in the room");
			}
			if (targetMembership === "join") {
				throw forbidden("Cannot invite user who is already in the room");
			}
			if (targetMembership === "ban") {
				throw forbidden("Cannot invite banned user");
			}
			if (event.sender === targetUserId) {
				throw forbidden("Cannot invite yourself");
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
			// Kick: sender must be joined
			if (senderMembership !== "join") {
				throw forbidden("Sender is not in the room");
			}
			// Target must actually be in the room (join or invite) to be kicked
			if (targetMembership !== "join" && targetMembership !== "invite") {
				throw forbidden("Cannot kick a user who is not in the room");
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

		case "knock": {
			if (event.sender !== targetUserId) {
				throw forbidden("Cannot knock on behalf of another user");
			}
			if (senderMembership === "ban") {
				throw forbidden("User is banned from the room");
			}
			if (senderMembership === "join") {
				throw forbidden("User is already in the room");
			}
			// A re-knock (knock -> knock) is permitted by the spec.
			if (senderMembership === "invite") {
				throw forbidden("User is already invited");
			}

			const joinRulesEvent = roomState.state_events.get(
				"m.room.join_rules\0",
			);
			const knockJoinRule = joinRulesEvent
				? ((joinRulesEvent.content as Record<string, unknown>)
						.join_rule as string)
				: "invite";

			if (knockJoinRule !== "knock" && knockJoinRule !== "knock_restricted") {
				throw forbidden(
					"Room join rules do not allow knocking",
				);
			}
			return;
		}

		default:
			throw forbidden(`Unknown membership: ${membership}`);
	}
};

/**
 * Validate a single power-level value: in room version 10+ it must be an
 * integer, and (matching Synapse's event validator / `CANONICALJSON_MAX_INT`)
 * it must fall within the range representable in canonical JSON, i.e.
 * `±(2**53 - 1)`. A value such as `2**53` is rejected. The error is `M_BAD_JSON`
 * so the CS API returns HTTP 400.
 */
const validatePowerLevelValue = (label: string, val: unknown): void => {
	if (typeof val !== "number") return;
	if (!Number.isInteger(val)) {
		throw badJson(
			`Power level value for ${label} must be an integer in room version 10+`,
		);
	}
	if (val > CANONICALJSON_MAX_INT || val < CANONICALJSON_MIN_INT) {
		throw badJson(
			`Power level value for ${label} is out of range for canonical JSON`,
		);
	}
};

const validateIntegerPowerLevels = (event: PDU): void => {
	const content = event.content as Record<string, unknown>;
	const intFields = [
		"ban",
		"events_default",
		"invite",
		"kick",
		"redact",
		"state_default",
		"users_default",
	];
	for (const field of intFields) {
		if (field in content) {
			validatePowerLevelValue(`'${field}'`, content[field]);
		}
	}
	for (const mapField of ["events", "users", "notifications"] as const) {
		const map = content[mapField] as Record<string, unknown> | undefined;
		if (map && typeof map === "object") {
			for (const [key, val] of Object.entries(map)) {
				validatePowerLevelValue(`${mapField} entry '${key}'`, val);
			}
		}
	}
};

export const checkEventAuth = (
	event: PDU,
	_eventId: EventId,
	roomState: RoomState,
): void => {
	const isV12Plus = isRoomVersion12Plus(roomState.room_version);

	if (event.type === "m.room.create") {
		if (roomState.state_events.size > 0) {
			// A second m.room.create can never be sent into an existing room
			// (MSC4291 / event auth rule 1). Clients receive HTTP 400.
			throw badJson("m.room.create can only be the first event in a room");
		}
		// In v12, the create event must NOT have a room_id in the event body
		// (it's derived from the hash). However, we still store room_id on the PDU
		// for internal use — this check validates that auth_events is empty for create.
		if (isV12Plus && event.auth_events.length > 0) {
			throw forbidden(
				"m.room.create must not have auth_events in room version 12+",
			);
		}
		// Validate additional_creators (MSC4289 check_valid_additional_creators).
		if (isV12Plus) {
			const additionalCreators = (event.content as Record<string, unknown>)
				.additional_creators;
			if (additionalCreators !== undefined) {
				validateAdditionalCreators(additionalCreators);
			}
		}
		return;
	}

	// In v12, m.room.create must NOT be in auth_events
	if (isV12Plus) {
		const createEvent = roomState.state_events.get("m.room.create\0");
		if (createEvent) {
			const createEventId = computeEventId(createEvent);
			if (event.auth_events.includes(createEventId)) {
				throw forbidden(
					"m.room.create must not be referenced in auth_events in room version 12+",
				);
			}
		}
	}

	if (event.type === "m.room.member") {
		checkMembershipAuth(event, roomState);
		return;
	}

	const senderMembership = getMembership(roomState, event.sender);
	if (senderMembership !== "join") {
		throw forbidden("Sender is not in the room");
	}

	// Room version 10+ requires integer power levels
	if (event.type === "m.room.power_levels") {
		const roomVersion = roomState.room_version ?? "1";
		const versionNum = parseInt(roomVersion, 10);
		if (!isNaN(versionNum) && versionNum >= 10) {
			validateIntegerPowerLevels(event);
		}
		// MSC4289: in v12+ the room creator(s) hold an implicit infinite power
		// level and must NOT be listed in the power_levels `users` map. Synapse
		// rejects this with SynapseError(400, ...), so we use badJson (HTTP 400).
		if (isV12Plus) {
			const users = (event.content as Record<string, unknown>).users as
				| Record<string, number>
				| undefined;
			if (users) {
				const createEvent = roomState.state_events.get("m.room.create\0");
				if (createEvent) {
					const creator = createEvent.sender;
					const additionalCreators = (
						createEvent.content as Record<string, unknown>
					).additional_creators as string[] | undefined;
					if (creator in users) {
						throw badJson(
							`Creator user ${creator} must not appear in content.users`,
						);
					}
					if (additionalCreators) {
						for (const uid of additionalCreators) {
							if (uid in users) {
								throw badJson(
									"Additional creators users must not appear in content.users",
								);
							}
						}
					}
				}
			}
		}
	}

	const isState = event.state_key !== undefined;
	const requiredPl = getEventPowerLevel(event.type, isState, roomState);
	const senderPl = getUserPowerLevel(event.sender, roomState);
	if (senderPl < requiredPl) {
		throw forbidden(
			`Insufficient power level: need ${requiredPl}, have ${senderPl}`,
		);
	}

	// MSC3757 owned state events.
	//
	// A state event whose state_key starts with "@" and is NOT exactly the
	// sender's own user ID is normally only writable by anyone (subject to the
	// power-level check above). Both with and without MSC3757, a state_key that
	// looks like *another* user's ID is write-protected here; MSC3757 only
	// changes *who* may write it.
	//
	// Mirrors Synapse `_can_send_event` (event_auth.py): the owner of a state
	// key (whose state_key equals their user ID, or starts with their user ID
	// followed by "_") may set it, and so may anyone with strictly higher power
	// level than that owner. Without MSC3757 enabled, no one may set state keyed
	// by another user ID (normal power levels still apply, so this is a stricter
	// gate, never a looser one).
	const stateKey = event.state_key;
	if (stateKey !== undefined && stateKey.startsWith("@") && stateKey !== event.sender) {
		if (isMsc3757Enabled(roomState.room_version)) {
			// Parse the owning user ID out of the state key: it is the state key
			// up to (but excluding) the first "_" that appears after the domain's
			// leading colon, or the whole state key if there is no such "_".
			const colonIdx = stateKey.indexOf(":", 1);
			if (colonIdx === -1) {
				throw badJson(
					"State key neither equals a valid user ID, nor starts with one plus an underscore",
				);
			}
			const suffixIdx = stateKey.indexOf("_", colonIdx + 1);
			const stateKeyUserId =
				suffixIdx === -1 ? stateKey : stateKey.slice(0, suffixIdx);
			if (!isValidUserId(stateKeyUserId)) {
				throw badJson(
					"State key neither equals a valid user ID, nor starts with one plus an underscore",
				);
			}
			// Allowed if the sender owns the state key, or has strictly higher
			// power level than the owner.
			if (
				stateKeyUserId === event.sender ||
				senderPl > getUserPowerLevel(stateKeyUserId as UserId, roomState)
			) {
				return;
			}
		}
		throw forbidden("You are not allowed to set others' state");
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

export const isWorldReadable = (roomState: RoomState): boolean => {
	const hvEvent = roomState.state_events.get(
		"m.room.history_visibility\0",
	);
	if (!hvEvent) return false;
	return (
		(hvEvent.content as Record<string, unknown>).history_visibility ===
		"world_readable"
	);
};

export const requireJoinedOrWorldReadable = async (
	storage: Storage,
	roomId: string,
	userId: string | undefined,
): Promise<RoomState> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw roomNotFound();
	if (userId) {
		const membership = getMembership(room, userId);
		if (membership === "join") return room;
		if (membership === "leave") {
			const hvEvent = room.state_events.get("m.room.history_visibility\0");
			const hv = hvEvent
				? (hvEvent.content as Record<string, unknown>).history_visibility
				: undefined;
			if (hv === "shared" || hv === "world_readable") return room;
		}
	}
	if (isWorldReadable(room)) return room;
	throw notJoined();
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
	signingKey?: SigningKey,
	federationClient?: FederationClient,
): Promise<string> => {
	const authEvents = selectAuthEvents(type, stateKey, ctx.roomState, sender);
	// When a signing key is supplied the event is signed by our server. Signing
	// is additive: it injects `signatures` (and recomputes `hashes`) but does NOT
	// change the event ID, which is derived from the redacted form (signatures and
	// unsigned are stripped before hashing). This keeps event IDs stable whether
	// or not federation is active.
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
		signingKey,
	});

	checkEventAuth(event, eventId, ctx.roomState);
	await storage.setStateEvent(ctx.roomState.room_id, event, eventId);

	ctx.depth++;
	ctx.prevEvents = [eventId];
	ctx.roomState.depth = ctx.depth;
	ctx.roomState.forward_extremities = [eventId];

	// Fan the (signed) event out to remote servers in the room. Best-effort and
	// fire-and-forget; only happens when both a signing key and federation client
	// are available (i.e. federation is enabled and the event is signed).
	if (signingKey && federationClient) {
		await fanoutEvent(
			storage,
			serverName,
			signingKey,
			federationClient,
			ctx.roomState.room_id as RoomId,
			event,
			eventId,
		);
	}

	return eventId;
};
