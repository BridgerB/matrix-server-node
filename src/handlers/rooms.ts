import { generateRoomId } from "../crypto.ts";
import {
	badJson,
	forbidden,
	MatrixError,
	missingParam,
	notFound,
	roomNotFound,
} from "../errors.ts";
import {
	buildEvent,
	checkEventAuth,
	computeEventId,
	computeRoomIdV12,
	type EventContext,
	getMembership,
	getPowerLevels,
	getUserPowerLevel,
	isRoomVersion12Plus,
	selectAuthEvents,
	sendStateEvent,
	validateAdditionalCreators,
} from "../events.ts";
import type { FederationClient } from "../federation/client.ts";
import { fanoutEvent } from "../federation/outbound.ts";

import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import { signEvent } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type {
	EventId,
	MatrixErrorCode,
	RoomId,
	ServerName,
	UserId,
} from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";
import type { JsonObject } from "../types/json.ts";
import type { CreateRoomRequest } from "../types/room-operations.ts";
import type { RoomVersion } from "../types/room-versions.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";

/**
 * For a restricted (or knock_restricted) room, find a LOCAL user who is joined
 * to this room and has permission to issue invites. This user is recorded in a
 * restricted join event's `content.join_authorised_via_users_server`. Returns
 * undefined if no such local user exists.
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
		const memberServer = memberId.split(":").slice(1).join(":");
		if (memberServer !== localServerName) continue;

		if (getUserPowerLevel(memberId, room) >= invitePl) {
			return memberId;
		}
	}
	return undefined;
};

/**
 * Determine whether our server is "resident" in a locally-known room, i.e. it
 * has full room state and at least one local user who is currently joined.
 *
 * A room can exist locally without us being resident: e.g. when we have only
 * received and stored a stripped invite (via PUT /federation/.../invite) for a
 * remote-owned room, the room has no `m.room.create` event and no joined local
 * member. In that situation a join must be performed over federation (mirroring
 * dendrite's `serverInRoom` check in roomserver/internal/perform/perform_join.go:
 * a forced federated join when we are not in the room).
 */
const isServerResidentInRoom = (
	room: RoomState,
	localServerName: string,
): boolean => {
	// Without the create event we never have authoritative room state and cannot
	// build valid events locally.
	if (!room.state_events.has("m.room.create\0")) return false;

	for (const [key, event] of room.state_events) {
		if (!key.startsWith("m.room.member\0")) continue;
		const membership = (event.content as Record<string, unknown>)
			.membership as string | undefined;
		if (membership !== "join") continue;
		const memberId = key.slice("m.room.member\0".length);
		const memberServer = memberId.split(":").slice(1).join(":");
		if (memberServer === localServerName) return true;
	}
	return false;
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

export const postCreateRoom =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as CreateRoomRequest;
		const userId = req.userId as string;
		const roomVersion = body.room_version ?? "10";
		const v12Plus = isRoomVersion12Plus(roomVersion);

		// Validate room_version is a known version
		const KNOWN_ROOM_VERSIONS = new Set([
			"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
			// MSC3757 (owned state events) unstable room version
			"org.matrix.msc3757.10",
		]);
		if (
			body.room_version !== undefined &&
			typeof body.room_version !== "string"
		) {
			throw badJson("room_version must be a string");
		}
		if (body.room_version !== undefined && !KNOWN_ROOM_VERSIONS.has(body.room_version)) {
			throw new MatrixError(
				"M_UNSUPPORTED_ROOM_VERSION",
				`Unsupported room version: ${body.room_version}`,
				400,
			);
		}

		// Validate visibility
		if (
			body.visibility !== undefined &&
			body.visibility !== "public" &&
			body.visibility !== "private"
		) {
			throw badJson("visibility must be 'public' or 'private'");
		}

		// Validate room_alias_name (local part only, no special chars)
		if (body.room_alias_name !== undefined) {
			if (!/^[a-zA-Z0-9._=\-/]+$/.test(body.room_alias_name)) {
				throw badJson("room_alias_name contains invalid characters");
			}
		}

		let roomId: string;

		const preset =
			body.preset ??
			(body.visibility === "public" ? "public_chat" : "private_chat");

		// `room_version` and `creator` in creation_content are ignored — the server
		// sets them authoritatively (spec: POST /createRoom creation_content).
		const {
			room_version: _ignoredVersion,
			creator: _ignoredCreator,
			...creationContentRest
		} = (body.creation_content ?? {}) as JsonObject;
		const createContent: JsonObject = {
			...creationContentRest,
			room_version: roomVersion,
		};

		// Room versions before 11 require "creator" in create event content
		const roomVersionNum = parseInt(roomVersion, 10);
		if (!isNaN(roomVersionNum) && roomVersionNum < 11) {
			createContent.creator = userId;
		}

		if (v12Plus) {
			// MSC4289: validate `additional_creators` (check_valid_additional_creators)
			// BEFORE a room is created, so malformed values 400 early. We reuse the
			// exact validation exported from events.ts.
			if (createContent.additional_creators !== undefined) {
				validateAdditionalCreators(createContent.additional_creators);
			}

			// MSC4289: in v12+ the `trusted_private_chat` preset makes the invited
			// users room creators rather than PL100 admins. They are merged (and
			// deduped) into the create event's `additional_creators` alongside any
			// explicitly-supplied ones, instead of being written to
			// power_levels.users.
			if (preset === "trusted_private_chat" && body.invite) {
				const existing = (createContent.additional_creators ??
					[]) as string[];
				const merged = [...existing];
				for (const invitee of body.invite) {
					if (invitee !== userId && !merged.includes(invitee)) {
						merged.push(invitee);
					}
				}
				if (merged.length > 0) {
					createContent.additional_creators = merged;
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
			signingKey,
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.member",
			userId,
			{ membership: "join" },
			signingKey,
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
				// MSC4289: in v12+ trusted_private_chat invitees are room creators
				// (added to create.content.additional_creators above), so they must
				// NOT appear in power_levels.users. For pre-v12 rooms they remain
				// PL100 admins as before.
				if (v12Plus) continue;
				(plContent.users as Record<string, number>)[invitee] = 100;
			}
		}
		if (body.power_level_content_override) {
			// MSC4289: do NOT strip the creator / additional_creators from the
			// override's users map. For v12 rooms creators must not appear in
			// power_levels.users, so passing them through lets checkEventAuth (in
			// events.ts) reject the power_levels event with a 400
			// ("power_level_content_override cannot set the room creator"). Non-creator
			// overrides flow through unchanged.
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
			signingKey,
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
			signingKey,
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
			signingKey,
		);

		// Guest access mirrors synapse's per-preset `guest_can_join`:
		//   public_chat               -> guest_can_join: false -> NO guest_access event
		//   private_chat / trusted_*  -> guest_can_join: true  -> guest_access: can_join
		// Emitting an m.room.guest_access for public_chat diverges from synapse and
		// breaks tests that assert public rooms have no guest_access state
		// (e.g. TestInboundCanReturnMissingEvents). So we only emit it when the
		// preset permits guests.
		if (preset !== "public_chat") {
			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				"m.room.guest_access",
				"",
				{
					guest_access: "can_join",
				},
				signingKey,
			);
		}

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
					signingKey,
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
				signingKey,
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
					"m.topic": {
						"m.text": [{ body: body.topic }],
					},
				},
				signingKey,
			);
		}

		if (body.invite) {
			// Mirror synapse (handlers/room.py): when a room is created with
			// `is_direct: true`, every invite's m.room.member content carries
			// `is_direct: true` so the invitee can detect a DM in their /sync
			// invite_state. The flag is only added when truthy.
			const inviteContent: JsonObject = { membership: "invite" };
			if (body.is_direct) inviteContent.is_direct = true;
			for (const invitee of body.invite) {
				const inviteeServer = invitee.includes(":")
					? invitee.split(":").slice(1).join(":")
					: serverName;
				if (signingKey && federationClient && inviteeServer !== serverName) {
					// Remote invitee: invite over federation so their server learns of
					// (and co-signs) the invite. performOutboundInvite reads the room's
					// current depth/forward_extremities from storage, so make sure the
					// in-memory ctx is flushed back onto the room first.
					roomState.depth = ctx.depth;
					roomState.forward_extremities = [...ctx.prevEvents] as EventId[];
					await performOutboundInvite(
						storage,
						serverName,
						signingKey,
						federationClient,
						inviteeServer as ServerName,
						roomId as RoomId,
						userId,
						invitee as UserId,
						undefined,
						body.is_direct === true,
					);
					// Re-sync ctx from the room state mutated by performOutboundInvite.
					ctx.depth = roomState.depth;
					ctx.prevEvents = [...roomState.forward_extremities];
				} else {
					await sendStateEvent(
						storage,
						serverName,
						ctx,
						userId,
						"m.room.member",
						invitee,
						{ ...inviteContent },
						signingKey,
					);
				}
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
				signingKey,
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
	extraContent?: JsonObject,
	signingKey?: SigningKey,
	federationClient?: FederationClient,
): Promise<string> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw roomNotFound();

	// Merge any client-supplied content first, then force the
	// server-controlled fields (membership and reason) on top so they
	// can never be overridden to an invalid value.
	const content: JsonObject = { ...(extraContent ?? {}), membership };
	if (reason) content.reason = reason;

	const ctx: EventContext = {
		roomState: room,
		depth: room.depth,
		prevEvents: [...room.forward_extremities],
	};

	// sendStateEvent signs the event (when a key is given) and fans it out to
	// remote servers in the room (when a federation client is given), so local
	// membership changes (join/leave/kick/ban) propagate to other servers.
	return sendStateEvent(
		storage,
		serverName,
		ctx,
		sender,
		"m.room.member",
		targetUserId,
		content,
		signingKey,
		federationClient,
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

		// The request body may carry arbitrary fields to merge into the
		// resulting m.room.member (join) event content (e.g. a custom key).
		// `reason` is pulled out and applied as the standard membership reason;
		// `membership` is stripped so it can't override the forced "join".
		const joinBody = (req.body ?? {}) as JsonObject;
		const {
			reason: joinReason,
			membership: _ignoredMembership,
			...extraJoinContent
		} = joinBody;

		// Attempt a federation join through any of the candidate servers. Used
		// both when the room is unknown locally and when the room is known but we
		// are not resident (e.g. we only hold a stripped invite).
		const attemptFederationJoin = async (): Promise<{
			status: number;
			body: { room_id: string };
		}> => {
			if (!signingKey || !federationClient) {
				throw roomNotFound();
			}

			// Candidate servers to contact:
			//  1. ?server_name= query params (Complement passes these)
			//  2. the server in the room ID
			//  3. servers of any remote users who invited us (so an invite from a
			//     remote server lets us join via that server, per dendrite)
			const serverNameParams = req.query.getAll("server_name");
			const roomServer = roomId.includes(":")
				? roomId.split(":").slice(1).join(":")
				: undefined;

			const serversToTry: string[] = [];
			for (const s of serverNameParams) {
				if (!serversToTry.includes(s)) serversToTry.push(s);
			}
			if (roomServer && !serversToTry.includes(roomServer)) {
				serversToTry.push(roomServer);
			}
			const existing = await storage.getRoom(roomId);
			if (existing) {
				const inviteEvent = existing.state_events.get(
					`m.room.member\0${userId}`,
				);
				const inviter = inviteEvent?.sender;
				if (typeof inviter === "string") {
					const inviterServer = inviter.split(":").slice(1).join(":");
					if (
						inviterServer &&
						inviterServer !== serverName &&
						!serversToTry.includes(inviterServer)
					) {
						serversToTry.push(inviterServer);
					}
				}
			}

			if (serversToTry.length === 0) {
				throw roomNotFound();
			}

			let lastError: unknown;
			for (const remoteServer of serversToTry) {
				try {
					return await performFederationJoin(
						storage,
						serverName,
						signingKey,
						federationClient,
						remoteServer as ServerName,
						roomId as RoomId,
						userId,
					);
				} catch (err) {
					console.error(
						`Federation join to ${remoteServer} failed:`,
						(err as Error).message,
					);
					lastError = err;
				}
			}

			if (lastError instanceof Error) throw lastError;
			throw roomNotFound();
		};

		// Check if room exists locally
		const room = await storage.getRoom(roomId);
		// We are resident only if we have full room state and a joined local user.
		// If the room is known locally but we are not resident (e.g. we only hold
		// a stripped invite for a remote room), the join must go over federation —
		// we cannot build a valid join event locally. This mirrors dendrite forcing
		// a federated join when the server is not in the room.
		if (room && !isServerResidentInRoom(room, serverName)) {
			return attemptFederationJoin();
		}
		if (room) {
			// For a restricted (or knock_restricted) room, a join that is neither a
			// rejoin nor the acceptance of an invite must be authorised by a local
			// user who has invite power, recorded in
			// content.join_authorised_via_users_server. Without it the join event
			// fails auth.
			const joinContent: JsonObject = { ...extraJoinContent };
			const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
			const joinRule = joinRulesEvent
				? ((joinRulesEvent.content as Record<string, unknown>)
						.join_rule as string)
				: "invite";
			const currentMembership = getMembership(room, userId);
			if (
				(joinRule === "restricted" || joinRule === "knock_restricted") &&
				currentMembership !== "join" &&
				currentMembership !== "invite"
			) {
				const satisfies = await userSatisfiesRestrictedAllow(
					storage,
					room,
					userId as UserId,
				);
				if (!satisfies) {
					throw forbidden(
						"You are not a member of any room that grants access to this room",
					);
				}
				const authoriser = findAuthorisingLocalUser(room, serverName);
				if (!authoriser) {
					// We have no local user able to authorise; fall through to a
					// remote join (handled below) when federation is available.
					if (signingKey && federationClient) {
						// no-op: drop through to federation path
					} else {
						throw forbidden(
							"No local user able to authorise this join",
						);
					}
				} else {
					joinContent.join_authorised_via_users_server = authoriser;
					await sendMembershipEvent(
						storage,
						serverName,
						roomId,
						userId,
						userId,
						"join",
						typeof joinReason === "string" ? joinReason : undefined,
						joinContent,
						signingKey,
						federationClient,
					);
					await clearForgottenMarker(storage, userId, roomId);
					return { status: 200, body: { room_id: roomId } };
				}
			} else {
				// Non-restricted local join (or rejoin / invite acceptance).
				await sendMembershipEvent(
					storage,
					serverName,
					roomId,
					userId,
					userId,
					"join",
					typeof joinReason === "string" ? joinReason : undefined,
					extraJoinContent,
					signingKey,
					federationClient,
				);
				await clearForgottenMarker(storage, userId, roomId);
				return { status: 200, body: { room_id: roomId } };
			}
		}

		// Room not found locally — attempt a federation join.
		return attemptFederationJoin();
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

	// 2. Fill in the template and sign it.
	// The template's content (membership: "join") is used as-is, which preserves
	// any `join_authorised_via_users_server` the resident server set for a
	// restricted-room join. This field is required for the join event to pass
	// auth on every participating server.
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
	// Include our join event in the state.
	const allState = [...stateEvents, sendJoinBody.event ?? signedEvent];

	// In room version 12+, the m.room.create event has no `room_id` in its body
	// (the room ID is derived from the create event hash). Storage needs a
	// non-null room_id on every event row, so inject it onto any event that is
	// missing it before importing. This does not affect event IDs/signatures
	// because those are computed over the redacted event, and for v12 create
	// events `room_id` is not part of the redacted/reference form.
	const ensureRoomId = (events: PDU[]): PDU[] =>
		events.map((e) =>
			e.room_id ? e : ({ ...e, room_id: roomId } as PDU),
		);

	await storage.importRoomState(
		roomId,
		roomVersion,
		ensureRoomId(allState),
		ensureRoomId(authChain),
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
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const userId = req.userId as string;
		const body = (req.body ?? {}) as { reason?: string };

		// A leave of a remote-owned room must be performed over federation via
		// make_leave/send_leave so the room's owning/resident servers learn about
		// it. A purely local leave would never reach them. We key off room
		// ownership (the server in the room ID) rather than our own residency,
		// because even when a local user is the only member we know about, the
		// authoritative copy of the room lives on the owning server and must be
		// told. This mirrors how dendrite/synapse distribute membership changes.
		const roomServer = roomId.includes(":")
			? roomId.split(":").slice(1).join(":")
			: undefined;
		const needsFederation =
			signingKey !== undefined &&
			federationClient !== undefined &&
			roomServer !== undefined &&
			roomServer !== serverName;

		if (needsFederation) {
			try {
				await performFederationLeave(
					storage,
					serverName,
					signingKey as SigningKey,
					federationClient as FederationClient,
					roomServer as ServerName,
					roomId as RoomId,
					userId,
					body.reason,
				);
				return { status: 200, body: {} };
			} catch (err) {
				console.error(
					`Federation leave to ${roomServer} failed:`,
					(err as Error).message,
				);
				// Fall through to a best-effort local leave so the client at least
				// stops seeing the room.
			}
		}

		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			userId,
			userId,
			"leave",
			body.reason,
			undefined,
			signingKey,
			federationClient,
		);
		return { status: 200, body: {} };
	};

/**
 * Perform a federation leave of a remote-owned room on behalf of a local user.
 * Mirrors dendrite/synapse: GET make_leave to obtain a template, fill + sign it,
 * then PUT send_leave. On success the local membership is recorded as "leave"
 * so the user's own /sync reflects the departure.
 */
const performFederationLeave = async (
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	federationClient: FederationClient,
	remoteServer: ServerName,
	roomId: RoomId,
	userId: string,
	reason?: string,
): Promise<void> => {
	const makeLeaveResp = await federationClient.request(
		remoteServer,
		"GET",
		`/_matrix/federation/v1/make_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
	);
	if (makeLeaveResp.status !== 200) {
		const b = makeLeaveResp.body as Record<string, unknown> | undefined;
		throw new Error(
			`make_leave failed: ${b?.error ?? b?.errcode ?? `status ${makeLeaveResp.status}`}`,
		);
	}

	const makeLeaveBody = makeLeaveResp.body as {
		room_version?: string;
		event?: PDU;
	};
	const template = makeLeaveBody.event;
	if (!template) throw new Error("make_leave response missing event template");

	if (!template.room_id) {
		(template as unknown as Record<string, unknown>).room_id = roomId;
	}
	const content = (template.content ?? {}) as Record<string, unknown>;
	content.membership = "leave";
	if (reason) content.reason = reason;
	template.content = content as PDU["content"];
	template.origin_server_ts = Date.now();

	const signedEvent = signEvent(template, serverName as ServerName, signingKey);
	const eventId = computeEventId(signedEvent);

	const sendLeaveResp = await federationClient.request(
		remoteServer,
		"PUT",
		`/_matrix/federation/v2/send_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`,
		signedEvent,
	);
	if (sendLeaveResp.status !== 200) {
		const b = sendLeaveResp.body as Record<string, unknown> | undefined;
		throw new Error(
			`send_leave failed: ${b?.error ?? b?.errcode ?? `status ${sendLeaveResp.status}`}`,
		);
	}

	// Record the leave locally so the user's own /sync reflects the departure.
	const room = await storage.getRoom(roomId);
	if (room) {
		await storage.setStateEvent(roomId, signedEvent, eventId);
		room.depth = Math.max(room.depth, signedEvent.depth + 1);
		room.forward_extremities = [eventId];
	} else {
		await storage.importRoomState(
			roomId,
			(makeLeaveBody.room_version ?? "10") as RoomVersion,
			[signedEvent],
			[],
		);
	}
};

export const postInvite =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const body = req.body as
			| { user_id?: string; reason?: string; is_direct?: boolean }
			| undefined;
		if (!body?.user_id) throw missingParam("Missing 'user_id'");

		const inviteeServer = body.user_id.includes(":")
			? body.user_id.split(":").slice(1).join(":")
			: serverName;

		// A remote invitee must be invited over federation (PUT /v2/invite) so the
		// invitee's server learns about (and co-signs) the invite. Mirrors
		// synapse's FederationHandler.send_invite / the inbound putFederationInvite
		// we already implement on the receiving side.
		if (
			signingKey &&
			federationClient &&
			inviteeServer !== serverName
		) {
			await performOutboundInvite(
				storage,
				serverName,
				signingKey,
				federationClient,
				inviteeServer as ServerName,
				roomId as RoomId,
				req.userId as string,
				body.user_id as UserId,
				body.reason,
				body.is_direct === true,
			);
			return { status: 200, body: {} };
		}

		// Thread `is_direct` into the invite member content when the caller marks
		// this as a direct (DM) invite, mirroring synapse so the invitee can detect
		// the DM in their /sync invite_state.
		const inviteExtra: JsonObject | undefined =
			body.is_direct === true ? { is_direct: true } : undefined;
		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			req.userId as string,
			body.user_id,
			"invite",
			body.reason,
			inviteExtra,
			signingKey,
			federationClient,
		);
		return { status: 200, body: {} };
	};

/**
 * Invite a remote user over federation. Builds and signs the m.room.member
 * (invite) event locally, PUTs it to the invitee's server at
 * /_matrix/federation/v2/invite/{roomId}/{eventId} along with the room version
 * and the room's stripped state, then stores the co-signed event returned by
 * that server. Mirrors the inbound putFederationInvite co-sign pattern and
 * dendrite/synapse outbound invite flow.
 */
const performOutboundInvite = async (
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	federationClient: FederationClient,
	inviteeServer: ServerName,
	roomId: RoomId,
	sender: string,
	targetUserId: UserId,
	reason?: string,
	isDirect?: boolean,
): Promise<void> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw roomNotFound();

	const content: JsonObject = { membership: "invite" };
	if (reason) content.reason = reason;
	if (isDirect) content.is_direct = true;

	const authEvents = selectAuthEvents(
		"m.room.member",
		targetUserId,
		room,
		sender as UserId,
	);
	const { event, eventId } = buildEvent({
		roomId,
		sender: sender as UserId,
		type: "m.room.member",
		content,
		stateKey: targetUserId,
		depth: room.depth,
		prevEvents: [...room.forward_extremities],
		authEvents,
		serverName: serverName as ServerName,
		signingKey,
	});

	// Local auth check before sending — the inviter must have permission.
	checkEventAuth(event, eventId, room);

	const strippedState = await storage.getStrippedState(roomId);

	const inviteResp = await federationClient.request(
		inviteeServer,
		"PUT",
		`/_matrix/federation/v2/invite/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`,
		{
			room_version: room.room_version,
			event,
			invite_room_state: strippedState,
		},
	);

	if (inviteResp.status !== 200) {
		const b = inviteResp.body as Record<string, unknown> | undefined;
		throw new MatrixError(
			(typeof b?.errcode === "string"
				? b.errcode
				: "M_UNKNOWN") as MatrixErrorCode,
			typeof b?.error === "string"
				? b.error
				: `invite failed: status ${inviteResp.status}`,
			inviteResp.status === 403 ? 403 : 400,
		);
	}

	// The remote server returns the invite event co-signed with its signature.
	// Store that (it merges both servers' signatures) so our copy is fully
	// signed. Fall back to our locally-signed event if the response is malformed.
	const respBody = inviteResp.body as { event?: PDU } | undefined;
	const storedEvent =
		respBody?.event && typeof respBody.event === "object"
			? respBody.event
			: event;

	await storage.setStateEvent(roomId, storedEvent, eventId);
	room.depth = room.depth + 1;
	room.forward_extremities = [eventId];

	// Also propagate to any OTHER remote servers already in the room (the
	// invitee's own server already has it via /invite).
	await fanoutEvent(
		storage,
		serverName,
		signingKey,
		federationClient,
		roomId,
		storedEvent,
		eventId,
	);
};

export const postKnock =
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
		const body = (req.body ?? {}) as { reason?: string };

		const room = await storage.getRoom(roomId);

		// If the room is remote-owned and we are not resident, knock over
		// federation (make_knock/send_knock) so the resident servers learn of the
		// knock. Candidate servers come from ?server_name= and the room ID, plus
		// any server we already know holds this room.
		const roomServer = roomId.includes(":")
			? roomId.split(":").slice(1).join(":")
			: undefined;
		const needsFederation =
			signingKey !== undefined &&
			federationClient !== undefined &&
			(room === undefined || !isServerResidentInRoom(room, serverName)) &&
			roomServer !== serverName;

		if (needsFederation) {
			const serversToTry: string[] = [];
			for (const s of req.query.getAll("server_name")) {
				if (!serversToTry.includes(s)) serversToTry.push(s);
			}
			if (roomServer && !serversToTry.includes(roomServer)) {
				serversToTry.push(roomServer);
			}
			if (serversToTry.length === 0) throw roomNotFound();

			let lastError: unknown;
			for (const remoteServer of serversToTry) {
				try {
					await performFederationKnock(
						storage,
						serverName,
						signingKey as SigningKey,
						federationClient as FederationClient,
						remoteServer as ServerName,
						roomId as RoomId,
						userId,
						body.reason,
					);
					return { status: 200, body: { room_id: roomId } };
				} catch (err) {
					console.error(
						`Federation knock to ${remoteServer} failed:`,
						(err as Error).message,
					);
					lastError = err;
				}
			}
			if (lastError instanceof MatrixError) throw lastError;
			if (lastError instanceof Error) throw lastError;
			throw roomNotFound();
		}

		await sendMembershipEvent(
			storage,
			serverName,
			roomId,
			userId,
			userId,
			"knock",
			body.reason,
			undefined,
			signingKey,
			federationClient,
		);
		return { status: 200, body: { room_id: roomId } };
	};

/**
 * Perform a federation knock on a remote-owned room for a local user. Mirrors
 * synapse's FederationHandler.do_knock: GET make_knock to obtain a template,
 * fill in the reason + sign it, then PUT send_knock. The send_knock response
 * carries `knock_room_state` (stripped state) which we stash on the knock
 * event's unsigned so it can be surfaced in the knocker's /sync (rooms.knock).
 * The knock member event is then stored locally as an out-of-band membership.
 */
const performFederationKnock = async (
	storage: Storage,
	serverName: string,
	signingKey: SigningKey,
	federationClient: FederationClient,
	remoteServer: ServerName,
	roomId: RoomId,
	userId: string,
	reason?: string,
): Promise<void> => {
	const makeKnockResp = await federationClient.request(
		remoteServer,
		"GET",
		`/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}?ver=1&ver=2&ver=3&ver=4&ver=5&ver=6&ver=7&ver=8&ver=9&ver=10&ver=11&ver=12`,
	);
	if (makeKnockResp.status !== 200) {
		const b = makeKnockResp.body as Record<string, unknown> | undefined;
		const errcode = (
			typeof b?.errcode === "string" ? b.errcode : "M_FORBIDDEN"
		) as MatrixErrorCode;
		const error =
			typeof b?.error === "string"
				? b.error
				: `make_knock failed: status ${makeKnockResp.status}`;
		throw new MatrixError(
			errcode,
			error,
			makeKnockResp.status === 403 ? 403 : 400,
		);
	}

	const makeKnockBody = makeKnockResp.body as {
		room_version?: string;
		event?: PDU;
	};
	const template = makeKnockBody.event;
	if (!template) throw new Error("make_knock response missing event template");

	if (!template.room_id) {
		(template as unknown as Record<string, unknown>).room_id = roomId;
	}
	const content = (template.content ?? {}) as Record<string, unknown>;
	content.membership = "knock";
	if (reason) content.reason = reason;
	template.content = content as PDU["content"];
	template.origin_server_ts = Date.now();

	const signedEvent = signEvent(template, serverName as ServerName, signingKey);
	const eventId = computeEventId(signedEvent);

	const sendKnockResp = await federationClient.request(
		remoteServer,
		"PUT",
		`/_matrix/federation/v1/send_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`,
		signedEvent,
	);
	if (sendKnockResp.status !== 200) {
		const b = sendKnockResp.body as Record<string, unknown> | undefined;
		const errcode = (
			typeof b?.errcode === "string" ? b.errcode : "M_FORBIDDEN"
		) as MatrixErrorCode;
		const error =
			typeof b?.error === "string"
				? b.error
				: `send_knock failed: status ${sendKnockResp.status}`;
		throw new MatrixError(
			errcode,
			error,
			sendKnockResp.status === 403 ? 403 : 400,
		);
	}

	const sendKnockBody = sendKnockResp.body as {
		knock_room_state?: unknown[];
	};
	const knockRoomState = Array.isArray(sendKnockBody.knock_room_state)
		? sendKnockBody.knock_room_state
		: [];

	// Stash the stripped room state on the knock event's unsigned so sync can
	// surface it under rooms.knock.<roomId>.knock_state (mirrors synapse storing
	// knock_room_state in unsigned).
	const storedEvent = {
		...signedEvent,
		unsigned: {
			...((signedEvent.unsigned as Record<string, unknown>) ?? {}),
			knock_room_state: knockRoomState,
		},
	} as PDU;

	// Persist the knock as an out-of-band membership so the knocker's /sync
	// reflects it. If we have no prior room record, seed a minimal one from the
	// stripped state plus our knock event.
	const room = await storage.getRoom(roomId);
	if (room) {
		await storage.setStateEvent(roomId, storedEvent, eventId);
		room.depth = Math.max(room.depth, storedEvent.depth + 1);
		room.forward_extremities = [eventId];
	} else {
		await storage.importRoomState(
			roomId,
			(makeKnockBody.room_version ?? "7") as RoomVersion,
			[storedEvent],
			[],
		);
	}
};

export const postKick =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
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
			undefined,
			signingKey,
			federationClient,
		);
		return { status: 200, body: {} };
	};

export const postBan =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
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
			undefined,
			signingKey,
			federationClient,
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
		const sender = req.userId as string;
		const targetUserId = body.user_id;
		const currentMembership = getMembership(room, targetUserId);
		if (currentMembership !== "ban") throw forbidden("User is not banned");

		// Unban is a `leave` event sent by another user against a banned target.
		// The shared auth check (checkMembershipAuth in src/events.ts, "leave" case)
		// rejects this because it treats every leave-against-another-user as a kick
		// and requires the target to currently be join/invite. Per the spec, an unban
		// (leave where the target is banned) is valid when the sender is joined and has
		// the ban power level. We therefore perform the unban authorization here and
		// store the resulting leave event directly, bypassing the kick-only check.
		const senderMembership = getMembership(room, sender);
		if (senderMembership !== "join") {
			throw forbidden("Sender is not in the room");
		}
		const pl = getPowerLevels(room);
		const banPl = pl.ban ?? 50;
		const senderPl = getUserPowerLevel(sender, room);
		if (senderPl < banPl) {
			throw forbidden(
				`Insufficient power level to unban: need ${banPl}, have ${senderPl}`,
			);
		}

		const content: JsonObject = { membership: "leave" };
		if (body.reason) content.reason = body.reason;

		const authEvents = selectAuthEvents(
			"m.room.member",
			targetUserId,
			room,
			sender as UserId,
		);
		const { event, eventId } = buildEvent({
			roomId: room.room_id as RoomId,
			sender: sender as UserId,
			type: "m.room.member",
			content,
			stateKey: targetUserId,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName: serverName as ServerName,
		});

		await storage.setStateEvent(room.room_id, event, eventId);
		room.depth = room.depth + 1;
		room.forward_extremities = [eventId];

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
			throw new MatrixError(
				"M_UNKNOWN",
				"User must have left the room before forgetting it",
				400,
			);
		}

		// There is no dedicated "forgotten" storage flag, so we record the
		// forgotten state as a per-user room account-data entry under the
		// internal type `m.internal.forgotten`. The access-control checks in
		// /messages, /state and the room filter in /sync read this marker to
		// reject/skip forgotten rooms (see FORGOTTEN_ROOM_MARKER consumers).
		await storage.setRoomAccountData(
			userId as UserId,
			roomId as RoomId,
			FORGOTTEN_ROOM_MARKER,
			{ forgotten: true },
		);

		return { status: 200, body: {} };
	};

/**
 * Internal room account-data type used to mark a room as "forgotten" by a
 * particular user. Stored via `setRoomAccountData(userId, roomId, ...)`.
 * Consumers (in room-events.ts and sync.ts) read this marker and treat
 * `content.forgotten === true` as "this user has forgotten this room".
 */
export const FORGOTTEN_ROOM_MARKER = "m.internal.forgotten";

/**
 * Clear the forgotten marker for a user/room. Called when the user re-joins a
 * previously forgotten room so that /messages, /state and /sync stop treating
 * the room as forgotten. (Synapse clears `forgotten` on the membership row when
 * a new membership event is recorded for the user.)
 */
const clearForgottenMarker = async (
	storage: Storage,
	userId: string,
	roomId: string,
): Promise<void> => {
	const existing = await storage.getRoomAccountData(
		userId as UserId,
		roomId as RoomId,
		FORGOTTEN_ROOM_MARKER,
	);
	if (existing && (existing as { forgotten?: unknown }).forgotten === true) {
		await storage.setRoomAccountData(
			userId as UserId,
			roomId as RoomId,
			FORGOTTEN_ROOM_MARKER,
			{ forgotten: false },
		);
	}
};
