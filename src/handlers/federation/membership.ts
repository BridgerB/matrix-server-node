import {
	forbidden,
	MatrixError,
	notFound,
	unableToAuthoriseJoin,
} from "../../errors.ts";
import {
	checkEventAuth,
	computeEventId,
	getMembership,
	getPowerLevels,
	getUserPowerLevel,
	selectAuthEvents,
} from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { FederationClient } from "../../federation/client.ts";
import { verifyOriginSignature } from "../../federation/verify.ts";
import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import { signEvent } from "../../signing.ts";
import type { Storage } from "../../storage/interface.ts";
import type { PDU, StrippedStateEvent } from "../../types/events.ts";
import type { EventId, RoomId, ServerName, UserId } from "../../types/index.ts";
import type { RoomState } from "../../types/internal.ts";
import type { RoomVersion } from "../../types/room-versions.ts";

/**
 * Domain (server name) portion of a Matrix identifier such as a user ID
 * (`@alice:example.com`) or room ID (`!abc:example.com`) — everything after the
 * first colon.
 */
const domainOf = (id: string): string => {
	const idx = id.indexOf(":");
	return idx === -1 ? "" : id.slice(idx + 1);
};

/**
 * Strict structural validation shared by send_join / send_leave / send_knock,
 * mirroring synapse's `_on_send_membership_event` and dendrite's
 * federationapi/routing/{join,leave}.go. The body must be a complete
 * m.room.member *state* event whose:
 *   - room_id matches the room_id in the request path,
 *   - type is m.room.member with a state_key present,
 *   - content.membership equals the membership expected by the endpoint,
 *   - state_key matches the sender (a membership event only ever affects its
 *     own sender's membership).
 *
 * Any failure raises a 400 M_BAD_JSON. This is what the Complement tests
 * TestCannotSendNon{Join,Leave,Knock}Via* assert: regular events, non-state
 * membership events, wrong membership types and mismatched state keys must all
 * be rejected with 400 before any auth/storage work happens.
 */
const validateMembershipEvent = (
	event: PDU,
	roomId: RoomId,
	expectedMembership: string,
): void => {
	if (!event || typeof event !== "object") {
		throw new MatrixError("M_BAD_JSON", "Missing membership event", 400);
	}
	if (event.room_id && event.room_id !== roomId) {
		throw new MatrixError(
			"M_BAD_JSON",
			"Room ID in body does not match that in request path",
			400,
		);
	}
	if (event.type !== "m.room.member" || typeof event.state_key !== "string") {
		throw new MatrixError("M_BAD_JSON", "Not an m.room.member event", 400);
	}
	if (
		(event.content as Record<string, unknown>)?.membership !==
		expectedMembership
	) {
		throw new MatrixError(
			"M_BAD_JSON",
			`Not a ${expectedMembership} event`,
			400,
		);
	}
	// A membership event must target its own sender (state_key === sender).
	// dendrite: "Event state key must match the event sender." This is what
	// rejects the "mismatched state key" Complement case.
	if (event.state_key !== event.sender) {
		throw new MatrixError(
			"M_BAD_JSON",
			"Event state key must match the event sender",
			400,
		);
	}
};

/**
 * Coerce an arbitrary value (from request body or event unsigned) into an array
 * of well-formed stripped state events. Anything malformed is dropped so a bad
 * `invite_room_state` can never crash the handler.
 */
const toStrippedState = (value: unknown): StrippedStateEvent[] => {
	if (!Array.isArray(value)) return [];
	const out: StrippedStateEvent[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.type !== "string") continue;
		if (typeof e.sender !== "string") continue;
		if (typeof e.state_key !== "string") continue;
		if (!e.content || typeof e.content !== "object") continue;
		out.push({
			content: e.content as StrippedStateEvent["content"],
			sender: e.sender as StrippedStateEvent["sender"],
			state_key: e.state_key,
			type: e.type,
		});
	}
	return out;
};

/**
 * For a restricted (or knock_restricted) room, find a LOCAL user who is joined
 * to this room and has permission to issue invites. This user is placed in the
 * joining member event's `content.join_authorised_via_users_server` so that the
 * resulting join event passes auth on every server. Returns undefined if no such
 * local user exists (the caller should then fail the make_join so the requesting
 * server can fail over to another resident server).
 */
const findAuthorisingLocalUser = (
	room: RoomState,
	localServerName: string,
): UserId | undefined => {
	const pl = getPowerLevels(room);
	const invitePl = pl.invite ?? 0;

	for (const [key, event] of room.state_events) {
		if (!key.startsWith("m.room.member\0")) continue;
		const membership = (event.content as Record<string, unknown>)
			.membership as string | undefined;
		if (membership !== "join") continue;

		const memberId = key.slice("m.room.member\0".length) as UserId;
		// Only local users can authorise a local-style join on this server.
		const memberServer = memberId.split(":").slice(1).join(":");
		if (memberServer !== localServerName) continue;

		if (getUserPowerLevel(memberId, room) >= invitePl) {
			return memberId;
		}
	}
	return undefined;
};

/**
 * Determine whether `userId` satisfies a restricted room's allow conditions,
 * i.e. they are joined to one of the rooms listed under
 * m.room.join_rules content.allow with type "m.room_membership".
 */
const userSatisfiesRestrictedAllow = async (
	storage: Storage,
	room: RoomState,
	userId: UserId,
): Promise<boolean> => {
	const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
	if (!joinRulesEvent) return false;
	const allow = (joinRulesEvent.content as Record<string, unknown>).allow;
	if (!Array.isArray(allow)) return false;

	for (const entry of allow) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "m.room_membership") continue;
		const allowedRoomId = e.room_id;
		if (typeof allowedRoomId !== "string") continue;

		const allowedRoom = await storage.getRoom(allowedRoomId as RoomId);
		if (!allowedRoom) continue;
		if (getMembership(allowedRoom, userId) === "join") return true;
	}
	return false;
};
export const getMakeJoin =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
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

		const content: Record<string, unknown> = { membership: "join" };

		const isRestricted =
			joinRule === "restricted" || joinRule === "knock_restricted";

		if (joinRule !== "public" && currentMembership !== "invite") {
			// A rejoin (already joined) is always allowed for any join rule.
			if (currentMembership !== "join") {
				if (isRestricted) {
					// The user must be a member of one of the allowed rooms.
					const satisfies = await userSatisfiesRestrictedAllow(
						storage,
						room,
						userId,
					);
					if (!satisfies) {
						throw unableToAuthoriseJoin(
							"User is not a member of any room in the allow list",
						);
					}
					// We must vouch for the join via a local user who can invite.
					// If we have no such local user, fail so the requesting server
					// can fail over to another resident server.
					const authoriser = findAuthorisingLocalUser(room, serverName);
					if (!authoriser) {
						throw unableToAuthoriseJoin(
							"No local user able to authorise this join",
						);
					}
					content.join_authorised_via_users_server = authoriser;
				} else {
					throw unableToAuthoriseJoin(
						"Room is not public and user is not invited",
					);
				}
			}
		}

		const authEvents = selectAuthEvents("m.room.member", userId, room, userId);

		const template: Partial<PDU> = {
			auth_events: authEvents,
			content: content as PDU["content"],
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
/**
 * Compute the subset of room state to return for an MSC3706 partial-state
 * send_join. Mirrors synapse's `_get_event_ids_for_partial_state_join`:
 *
 *   1. Every NON-member state event.
 *   2. The joining user's own current membership event, if any (it is an auth
 *      event for the new join, so it's cheap to include).
 *   3. If the room has no name and no canonical alias (i.e. a DM-style room that
 *      a client would render from its heroes), also include the membership
 *      events of the room "heroes" so the joining server can display the room.
 *      Heroes are joined members first, then invited members, excluding the
 *      joining user, capped at 5 (per the Room Summary rules used by /sync).
 */
const buildPartialStateEvents = (
	room: RoomState,
	joiningUser: UserId,
): PDU[] => {
	const memberPrefix = "m.room.member\0";
	const result: PDU[] = [];

	// 1. All non-member state events.
	for (const [key, ev] of room.state_events) {
		if (!key.startsWith(memberPrefix)) result.push(ev);
	}

	const memberFor = (userId: string): PDU | undefined =>
		room.state_events.get(memberPrefix + userId);
	const added = new Set<string>();
	const pushMember = (userId: string): void => {
		if (added.has(userId)) return;
		const ev = memberFor(userId);
		if (ev) {
			result.push(ev);
			added.add(userId);
		}
	};

	// 2. The joining user's current membership (e.g. an outstanding invite).
	pushMember(joiningUser);

	// 3. Heroes, only when the room has no name / canonical alias.
	const hasName = room.state_events.has("m.room.name\0");
	const hasCanonicalAlias = room.state_events.has("m.room.canonical_alias\0");
	if (!hasName && !hasCanonicalAlias) {
		const joined: { userId: string; ts: number }[] = [];
		const invited: { userId: string; ts: number }[] = [];
		for (const [key, ev] of room.state_events) {
			if (!key.startsWith(memberPrefix)) continue;
			const userId = key.slice(memberPrefix.length);
			if (userId === joiningUser) continue;
			const membership = (ev.content as Record<string, unknown>).membership;
			const ts = ev.origin_server_ts ?? 0;
			if (membership === "join") joined.push({ userId, ts });
			else if (membership === "invite") invited.push({ userId, ts });
		}
		// Approximate synapse's stream-ordering by origin_server_ts, then mxid.
		const byOrder = (
			a: { userId: string; ts: number },
			b: { userId: string; ts: number },
		): number => a.ts - b.ts || a.userId.localeCompare(b.userId);
		joined.sort(byOrder);
		invited.sort(byOrder);
		const heroes = [...joined, ...invited].slice(0, 5);
		for (const h of heroes) pushMember(h.userId);
	}

	return result;
};
export const putSendJoin =
	(
		storage: Storage,
		serverName: string,
		signingKey: SigningKey,
		federationClient: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const event = req.body as PDU;
		const origin = req.origin as string;

		// Strict structural validation before touching storage/auth: must be a
		// join m.room.member state event whose room_id matches the path and whose
		// state_key matches its sender. (TestCannotSendNonJoinViaSendJoinV1/V2.)
		validateMembershipEvent(event, roomId, "join");

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		// The join event must carry the room_id so it can be stored and so that
		// auth/state computations work consistently. v12 templates already include
		// room_id (we put it there in make_join); but be defensive for any client.
		if (!event.room_id) {
			(event as unknown as Record<string, unknown>).room_id = roomId;
		}

		try {
			await verifyOriginSignature(event, origin, storage, federationClient);
		} catch (err) {
			if (err instanceof MatrixError) throw err;
			throw forbidden(
				`Could not verify join event signature: ${(err as Error).message}`,
			);
		}

		let eventId: EventId;
		try {
			eventId = computeEventId(event);
		} catch (err) {
			throw new MatrixError(
				"M_BAD_JSON",
				`Could not compute event ID: ${(err as Error).message}`,
				400,
			);
		}

		// Auth check. For restricted joins, checkMembershipAuth verifies the
		// join_authorised_via_users_server user is a joined member here.
		checkEventAuth(event, eventId, room);

		let coSigned: PDU;
		try {
			coSigned = signEvent(event, serverName as ServerName, signingKey);
		} catch (err) {
			throw new MatrixError(
				"M_UNKNOWN",
				`Could not sign join event: ${(err as Error).message}`,
				500,
			);
		}

		await storage.setStateEvent(roomId, coSigned, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		// Ensure every state event we return carries room_id (v12 create events
		// derive their room_id from the hash and may lack it in the stored body).
		const withRoomId = (se: PDU): PDU =>
			se.room_id ? se : ({ ...se, room_id: roomId } as PDU);

		// MSC3706 / partial-state send_join: if the joining server set the
		// `omit_members=true` query param (only honoured on the v2 endpoint, which
		// is where the gomatrixserverlib SendJoinPartialState client sends it), we
		// may return a PARTIAL response: `members_omitted: true`, the non-member
		// state events (plus a small set of hero members so DM rooms render), the
		// servers currently in the room, and the auth_chain. The joining server
		// then back-fills the omitted member events lazily. Mirrors synapse
		// federation_server.on_send_join / _get_event_ids_for_partial_state_join.
		const omitMembers =
			req.path.includes("/_matrix/federation/v2/send_join/") &&
			req.query.get("omit_members") === "true";

		let stateEvents: PDU[];
		if (omitMembers) {
			stateEvents = buildPartialStateEvents(room, event.state_key as UserId).map(
				withRoomId,
			);
		} else {
			stateEvents = [...room.state_events.values()].map(withRoomId);
		}

		const authEventIds = stateEvents.flatMap((se) => se.auth_events);

		let authChain: PDU[];
		try {
			authChain = await storage.getAuthChain(authEventIds);
		} catch {
			authChain = [];
		}
		authChain = authChain.map((ae) =>
			ae.room_id ? ae : ({ ...ae, room_id: roomId } as PDU),
		);

		let servers: ServerName[];
		try {
			servers = await storage.getServersInRoom(roomId);
		} catch {
			servers = [serverName as ServerName];
		}

		const responseBody = {
			origin: serverName,
			auth_chain: authChain,
			state: stateEvents,
			event: coSigned,
			servers_in_room: servers,
			members_omitted: omitMembers,
		};

		// The v1 send_join endpoint wraps the response in a [200, {...}] array
		// envelope, whereas v2 returns the bare object. Detect which variant was
		// invoked from the request path.
		if (req.path.includes("/_matrix/federation/v1/send_join/")) {
			return { status: 200, body: [200, responseBody] };
		}

		return { status: 200, body: responseBody };
	};
export const getMakeLeave =
	(storage: Storage, _serverName: string): Handler =>
	async (req) => {
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
export const putSendLeave =
	(
		storage: Storage,
		_serverName: string,
		_signingKey: SigningKey,
		federationClient: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const event = req.body as PDU;
		const origin = req.origin as string;

		// Strict structural validation: must be a leave m.room.member state event
		// whose room_id matches the path and whose state_key matches its sender.
		// (TestCannotSendNonLeaveViaSendLeaveV1/V2.)
		validateMembershipEvent(event, roomId, "leave");

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!event.room_id) {
			(event as unknown as Record<string, unknown>).room_id = roomId;
		}

		await verifyOriginSignature(event, origin, storage, federationClient);

		const eventId = computeEventId(event);
		checkEventAuth(event, eventId, room);

		await storage.setStateEvent(roomId, event, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		// v1 send_leave wraps the (empty) response in a [200, {}] array envelope;
		// v2 returns the bare object.
		if (req.path.includes("/_matrix/federation/v1/send_leave/")) {
			return { status: 200, body: [200, {}] };
		}

		return { status: 200, body: {} };
	};
export const putFederationInvite =
	(
		storage: Storage,
		serverName: string,
		signingKey: SigningKey,
		federationClient: FederationClient,
	): Handler =>
	async (req) => {
		const body = req.body as {
			room_version?: string;
			event?: PDU;
			invite_room_state?: unknown[];
		};

		const event = body.event;
		const origin = req.origin as string;

		// Structural validation, mirroring synapse on_invite_request /
		// FederationHandler.on_invite_request: the body must carry an
		// m.room.member invite event with a state key for a local user, sent by
		// the requesting (origin) server.
		if (!event || typeof event !== "object") {
			throw new MatrixError("M_BAD_JSON", "Missing invite event", 400);
		}
		if (typeof event.state_key !== "string") {
			throw new MatrixError(
				"M_BAD_JSON",
				"The invite event did not have a state key",
				400,
			);
		}
		if (event.type !== "m.room.member") {
			throw new MatrixError(
				"M_BAD_JSON",
				"The event was not an m.room.member invite event",
				400,
			);
		}
		if ((event.content as Record<string, unknown>)?.membership !== "invite") {
			throw new MatrixError(
				"M_BAD_JSON",
				"The event was not an m.room.member invite event",
				400,
			);
		}

		const targetServer = domainOf(event.state_key);
		if (targetServer !== serverName)
			throw forbidden("Invited user is not on this server");

		await verifyOriginSignature(event, origin, storage, federationClient);

		// Co-sign the invite so the inviting server (and the invitee's client)
		// have our signature vouching that the invite was received here.
		const coSigned = signEvent(event, serverName as ServerName, signingKey);
		const eventId = computeEventId(coSigned);

		// The inviting server provides stripped room state so the invitee can see
		// room metadata (name, join_rules, ...) before joining. It may be sent
		// either as a top-level `invite_room_state` field or inside the event's
		// `unsigned.invite_room_state` (synapse uses the latter). Stash it on the
		// stored event's unsigned and seed the room's state from it so /sync's
		// invite_state and GET .../state both reflect it.
		const unsigned = (coSigned.unsigned ?? {}) as Record<string, unknown>;
		const strippedState = toStrippedState(
			body.invite_room_state ?? unsigned.invite_room_state,
		);
		unsigned.invite_room_state = strippedState;
		coSigned.unsigned = unsigned as PDU["unsigned"];

		const room = await storage.getRoom(event.room_id);
		if (!room) {
			// We are not resident in this room. Seed a minimal room from the
			// stripped state (create/join_rules/name/...) plus the invite member
			// event, so getStrippedState() returns full invite metadata and the
			// invitee's membership resolves to "invite".
			const seedState: PDU[] = [];
			for (const s of strippedState) {
				// Skip a stray member event for the invitee — the authoritative,
				// co-signed invite member event is appended last below.
				if (s.type === "m.room.member" && s.state_key === event.state_key)
					continue;
				seedState.push({
					auth_events: [],
					content: s.content,
					depth: 0,
					hashes: { sha256: "" },
					origin_server_ts: event.origin_server_ts,
					prev_events: [],
					room_id: event.room_id,
					sender: s.sender as PDU["sender"],
					signatures: {},
					state_key: s.state_key,
					type: s.type,
				} as PDU);
			}
			seedState.push(coSigned);

			await storage.importRoomState(
				event.room_id,
				(body.room_version ?? "10") as RoomVersion,
				seedState,
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
export const getMakeKnock =
	(storage: Storage, _serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.params.userId as UserId;

		// The knocking user must belong to the requesting (verified) origin server
		// (synapse on_make_knock_request).
		const userServer = userId.split(":").slice(1).join(":");
		if (userServer !== req.origin)
			throw forbidden("User does not belong to the requesting server");

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
		if (currentMembership === "join")
			throw forbidden("User is already in the room");
		if (currentMembership === "invite")
			throw forbidden("User is already invited to the room");

		if (joinRule !== "knock" && joinRule !== "knock_restricted")
			throw forbidden("Room does not support knocking");

		const authEvents = selectAuthEvents("m.room.member", userId, room, userId);

		const template: Partial<PDU> = {
			auth_events: authEvents,
			content: { membership: "knock" },
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
export const postExchangeThirdPartyInvite = (): Handler => (_req) => ({
	status: 200,
	body: {},
});

export const postThreePidOnBind = (): Handler => (_req) => ({
	status: 200,
	body: {},
});

export const putSendKnock =
	(
		storage: Storage,
		_serverName: string,
		_signingKey: SigningKey,
		federationClient: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const event = req.body as PDU;
		const origin = req.origin as string;

		// Strict structural validation, mirroring synapse _on_send_membership_event:
		// the body must be a knock m.room.member *state* event whose room_id
		// matches the request path, whose membership is "knock" and whose
		// state_key matches its sender. This runs before the join_rule/ACL checks
		// so wrong-type or wrong-membership events are rejected with 400 even in
		// rooms that don't support knocking. (TestCannotSendNonKnockViaSendKnock,
		// TestCannotSendKnockViaSendKnockInMSC3787Room.)
		validateMembershipEvent(event, roomId, "knock");

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!event.room_id) {
			(event as unknown as Record<string, unknown>).room_id = roomId;
		}

		// The knocking room version must actually support knocking.
		const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
		const joinRule = joinRulesEvent
			? ((joinRulesEvent.content as Record<string, unknown>).join_rule as string)
			: "invite";
		if (joinRule !== "knock" && joinRule !== "knock_restricted") {
			throw forbidden("Room does not support knocking");
		}

		if (!isServerAllowedByAcl(origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		await verifyOriginSignature(event, origin, storage, federationClient);

		const eventId = computeEventId(event);
		checkEventAuth(event, eventId, room);

		await storage.setStateEvent(roomId, event, eventId);
		room.depth = Math.max(room.depth, event.depth + 1);
		room.forward_extremities = [eventId];

		// Reply with stripped room state so the knocking server's clients can
		// display room metadata while the knock is pending (synapse
		// on_send_knock_request).
		const strippedState = await storage.getStrippedState(roomId);

		return {
			status: 200,
			body: { knock_room_state: strippedState },
		};
	};
