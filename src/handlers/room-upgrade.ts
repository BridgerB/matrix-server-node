import { generateRoomId } from "../crypto.ts";
import { badJson, forbidden } from "../errors.ts";
import {
	buildEvent,
	checkEventAuth,
	computeEventId,
	computeRoomIdV12,
	type EventContext,
	getUserPowerLevel,
	isRoomVersion12Plus,
	membershipOf,
	requireJoinedRoom,
	selectAuthEvents,
	sendStateEvent,
	validateAdditionalCreators,
} from "../events.ts";
import type { FederationClient } from "../federation/client.ts";
import { fanoutEvent } from "../federation/outbound.ts";
import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId, UserId } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";
import type { JsonObject } from "../types/json.ts";
import type { PushRule, PushRulesContent } from "../types/push.ts";
import type { RoomVersion } from "../types/room-versions.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";

const STATE_TO_COPY = [
	"m.room.join_rules",
	"m.room.history_visibility",
	"m.room.guest_access",
	"m.room.power_levels",
	"m.room.name",
	"m.room.topic",
	"m.room.avatar",
	"m.room.encryption",
	"m.room.server_acl",
	"m.room.pinned_events",
];

export const postRoomUpgrade =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const oldRoomId = req.params.roomId as RoomId;
		const userId = req.userId as string;
		const body = (req.body ?? {}) as {
			new_version?: string;
			additional_creators?: unknown;
		};

		if (!body.new_version) throw badJson("Missing new_version");

		const oldRoom = await requireJoinedRoom(storage, oldRoomId, userId);

		const senderPl = getUserPowerLevel(userId, oldRoom);
		const plEvent = oldRoom.state_events.get("m.room.power_levels\x1f");
		const pl = plEvent
			? (plEvent.content as unknown as RoomPowerLevelsContent)
			: undefined;
		const tombstonePl = pl?.events?.["m.room.tombstone"] ?? 100;
		if (senderPl < tombstonePl) {
			throw forbidden(
				`Insufficient power level: need ${tombstonePl}, have ${senderPl}`,
			);
		}

		const newVersion = body.new_version as RoomVersion;
		const v12Plus = isRoomVersion12Plus(newVersion);

		// MSC4291: when the REPLACEMENT room is v12+, its create event's
		// `predecessor` reference omits `event_id` and carries only `room_id`
		// (synapse `_calculate_upgraded_room_creation_content` is called with
		// `tombstone_event_id=None` for msc4291_room_ids_as_hashes rooms). For
		// pre-v12 replacement rooms we keep `event_id`, set to the OLD room's
		// create event ID, preserving the prior behaviour.
		const predecessor: JsonObject = { room_id: oldRoomId };
		if (!v12Plus) {
			const lastCreateEvent = oldRoom.state_events.get("m.room.create\x1f");
			predecessor.event_id = lastCreateEvent
				? computeEventId(lastCreateEvent, oldRoom.room_version)
				: ("" as EventId);
		}

		const newCreateContent: JsonObject = {
			room_version: body.new_version,
			predecessor,
		};

		// MSC4289: an upgrade to v12+ may carry `additional_creators` in the request
		// body. These users become room creators in the replacement room. Validate
		// them with the same rules as createRoom and copy them onto the new create
		// event. (Pre-v12 target rooms have no concept of additional creators, so we
		// ignore the field there.)
		const newCreators = new Set<string>([userId]);
		if (v12Plus && body.additional_creators !== undefined) {
			validateAdditionalCreators(body.additional_creators);
			const additionalCreators = body.additional_creators as string[];
			if (additionalCreators.length > 0) {
				newCreateContent.additional_creators = [...additionalCreators];
				for (const c of additionalCreators) newCreators.add(c);
			}
		}

		// Shared timestamp so the stored create event's ID equals the derived v12
		// room ID (see rooms.ts postCreateRoom for the rationale).
		const createOriginServerTs = Date.now();
		let newRoomId: RoomId;
		if (v12Plus) {
			const tempRoomId = "!placeholder:temp" as RoomId;
			const { event: tempCreateEvent } = buildEvent({
				roomId: tempRoomId,
				sender: userId,
				type: "m.room.create",
				content: newCreateContent,
				stateKey: "",
				depth: 0,
				prevEvents: [],
				authEvents: [],
				serverName,
				roomVersion: newVersion,
				originServerTs: createOriginServerTs,
			});
			const createForHash = { ...tempCreateEvent };
			delete (createForHash as Record<string, unknown>).room_id;
			newRoomId = computeRoomIdV12(createForHash) as RoomId;
		} else {
			newRoomId = generateRoomId(serverName) as RoomId;
		}

		const newRoomState: RoomState = {
			room_id: newRoomId,
			room_version: newVersion,
			state_events: new Map(),
			depth: 0,
			forward_extremities: [],
		};
		await storage.createRoom(newRoomState);

		const ctx: EventContext = {
			roomState: newRoomState,
			depth: 0,
			prevEvents: [],
		};

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.create",
			"",
			newCreateContent,
			signingKey,
			federationClient,
			createOriginServerTs,
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.member",
			userId,
			{
				membership: "join",
			},
			signingKey,
			federationClient,
		);

		for (const stateType of STATE_TO_COPY) {
			const oldEvent = oldRoom.state_events.get(`${stateType}\x1f`);
			if (!oldEvent) continue;

			const copiedContent: JsonObject = { ...oldEvent.content };

			// MSC4289: in a v12+ replacement room, anyone who is now a room creator
			// (the upgrader plus any request `additional_creators`) holds an implicit
			// infinite power level and must NOT appear in power_levels.users. Strip
			// them from the copied users map so the new PL event passes auth and the
			// resulting users map matches the spec.
			if (v12Plus && stateType === "m.room.power_levels") {
				const oldUsers = (copiedContent.users ?? {}) as JsonObject;
				const newUsers: JsonObject = {};
				for (const [uid, pl] of Object.entries(oldUsers)) {
					if (newCreators.has(uid)) continue;
					newUsers[uid] = pl;
				}
				copiedContent.users = newUsers;
			}

			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				stateType,
				oldEvent.state_key ?? "",
				copiedContent,
				signingKey,
				federationClient,
			);
		}

		const tombstoneAuthEvents = selectAuthEvents(
			"m.room.tombstone",
			"",
			oldRoom,
			userId,
		);
		const { event: tombstoneEvent, eventId: tombstoneEventId } = buildEvent({
			roomId: oldRoomId,
			sender: userId,
			type: "m.room.tombstone",
			content: {
				body: "This room has been replaced",
				replacement_room: newRoomId,
			},
			stateKey: "",
			depth: oldRoom.depth,
			prevEvents: [...oldRoom.forward_extremities],
			authEvents: tombstoneAuthEvents,
			serverName,
			roomVersion: oldRoom.room_version,
			signingKey,
		});

		checkEventAuth(tombstoneEvent, tombstoneEventId, oldRoom);
		await storage.setStateEvent(oldRoomId, tombstoneEvent, tombstoneEventId);
		oldRoom.depth++;
		oldRoom.forward_extremities = [tombstoneEventId];

		// Fan the tombstone out to every remote server resident in the OLD room.
		// Remote members (e.g. bob on hs2) are joined to the old room and must see
		// the tombstone over federation before they can find and join the
		// replacement room. The new room's create/member/state events were already
		// federated by sendStateEvent above, but the new room has no remote members
		// yet — the tombstone in the old room is the only signal remote members get.
		// Best-effort and fire-and-forget (same semantics as sendStateEvent fanout).
		if (signingKey && federationClient) {
			await fanoutEvent(
				storage,
				serverName,
				signingKey,
				federationClient,
				oldRoomId,
				tombstoneEvent,
				tombstoneEventId,
			);
		}

		// Copy over any room-scoped push rules for all local joined users from the
		// old room id to the new room id (matches Synapse's
		// copy_push_rules_from_room_to_room_for_user behaviour on upgrade).
		await migrateRoomPushRules(
			storage,
			serverName,
			oldRoom,
			oldRoomId,
			newRoomId,
		);

		return {
			status: 200,
			body: { replacement_room: newRoomId },
		};
	};

/**
 * Copy a user's `room`-ruleset push rule for `oldRoomId` to `newRoomId` in their
 * `m.push_rules` global account data, leaving the original in place. Idempotent:
 * a no-op if the user has no rule for the old room or already has one for the
 * new room. The account-data object is rebuilt rather than mutated in place.
 */
const copyRoomPushRule = async (
	storage: Storage,
	userId: UserId,
	oldRoomId: RoomId,
	newRoomId: RoomId,
): Promise<void> => {
	const raw = await storage.getGlobalAccountData(userId, "m.push_rules");
	if (!raw) return;

	const pushRules = raw as unknown as PushRulesContent;
	const roomRules = pushRules.global?.room;
	if (!Array.isArray(roomRules)) return;

	const existing = roomRules.find((r) => r.rule_id === oldRoomId);
	if (!existing) return;
	if (roomRules.some((r) => r.rule_id === newRoomId)) return;

	const copied: PushRule = { ...existing, rule_id: newRoomId };
	const updated: PushRulesContent = {
		...pushRules,
		global: { ...pushRules.global, room: [...roomRules, copied] },
	};
	await storage.setGlobalAccountData(
		userId,
		"m.push_rules",
		updated as unknown as JsonObject,
	);
};

/**
 * Migrate room-scoped push rules from `oldRoomId` to `newRoomId` for every local
 * user who is joined to the old room.
 *
 * This is shared between the two ways a room can be upgraded:
 *   1. `POST /rooms/{roomId}/upgrade` (handled here, in `postRoomUpgrade`).
 *   2. A "manual" upgrade where the client creates the replacement room itself
 *      and then sends an `m.room.tombstone` event to the old room. That path
 *      flows through `putStateEvent` (src/handlers/room-events.ts), which calls
 *      this whenever it persists an `m.room.tombstone` state event carrying a
 *      `replacement_room`.
 */
export async function migrateRoomPushRules(
	storage: Storage,
	serverName: string,
	oldRoom: RoomState,
	oldRoomId: RoomId,
	newRoomId: RoomId,
): Promise<void> {
	const suffix = `:${serverName}`;
	const localJoinedMembers = [...oldRoom.state_events]
		.filter(([key]) => key.startsWith("m.room.member\x1f"))
		.map(([, event]) => event)
		.filter(
			(event) =>
				event.state_key?.endsWith(suffix) && membershipOf(event) === "join",
		)
		.map((event) => event.state_key as UserId);

	for (const userId of localJoinedMembers) {
		await copyRoomPushRule(storage, userId, oldRoomId, newRoomId);
	}
}

/**
 * When a local user joins a room that REPLACES an earlier one (the room was
 * upgraded — possibly on a remote server), copy that user's room-scoped push
 * rule from the predecessor room to this one, mirroring synapse's
 * copy_push_rules_from_room_to_room_for_user run when a server becomes aware of
 * an upgrade. The predecessor is read from this room's `m.room.create` event
 * (`content.predecessor.room_id`). Idempotent: skips if the user has no rule for
 * the old room or already has one for the new room.
 *
 * This complements `migrateRoomPushRules` (which handles a LOCAL upgrade at the
 * time the tombstone is sent): here the upgrade happened elsewhere and we only
 * learn of it when our user joins the replacement room.
 * (TestPushRuleRoomUpgrade "joining a remote upgraded room ...".)
 */
export async function copyPredecessorPushRulesOnJoin(
	storage: Storage,
	userId: UserId,
	newRoomId: RoomId,
): Promise<void> {
	const createEv = await storage.getStateEvent(newRoomId, "m.room.create", "");
	const oldRoomId = (
		createEv?.event.content as
			| { predecessor?: { room_id?: string } }
			| undefined
	)?.predecessor?.room_id;
	if (!oldRoomId || oldRoomId === newRoomId) return;

	await copyRoomPushRule(storage, userId, oldRoomId as RoomId, newRoomId);
}
