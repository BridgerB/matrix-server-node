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
	requireJoinedRoom,
	selectAuthEvents,
	sendStateEvent,
} from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId } from "../types/index.ts";
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
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const oldRoomId = req.params.roomId as RoomId;
		const userId = req.userId as string;
		const body = (req.body ?? {}) as { new_version?: string };

		if (!body.new_version) throw badJson("Missing new_version");

		const oldRoom = await requireJoinedRoom(storage, oldRoomId, userId);

		const senderPl = getUserPowerLevel(userId, oldRoom);
		const plEvent = oldRoom.state_events.get("m.room.power_levels\0");
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

		const lastCreateEvent = oldRoom.state_events.get("m.room.create\0");
		const lastCreateEventId = lastCreateEvent
			? computeEventId(lastCreateEvent)
			: ("" as EventId);

		const newCreateContent = {
			room_version: body.new_version,
			predecessor: {
				room_id: oldRoomId,
				event_id: lastCreateEventId,
			},
		};

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
		);

		for (const stateType of STATE_TO_COPY) {
			const oldEvent = oldRoom.state_events.get(`${stateType}\0`);
			if (!oldEvent) continue;

			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				stateType,
				oldEvent.state_key ?? "",
				{ ...oldEvent.content },
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
		});

		checkEventAuth(tombstoneEvent, tombstoneEventId, oldRoom);
		await storage.setStateEvent(oldRoomId, tombstoneEvent, tombstoneEventId);
		oldRoom.depth++;
		oldRoom.forward_extremities = [tombstoneEventId];

		// Copy over any room-scoped push rules for all local joined users from the
		// old room id to the new room id (matches Synapse's
		// copy_push_rules_from_room_to_room_for_user behaviour on upgrade).
		await migrateRoomPushRules(storage, serverName, oldRoom, oldRoomId, newRoomId);

		return {
			status: 200,
			body: { replacement_room: newRoomId },
		};
	};

/**
 * Migrate room-scoped push rules from `oldRoomId` to `newRoomId` for every
 * local user who is joined to the old room. For each such user, if their
 * `m.push_rules` global account data contains a rule in the `room` ruleset
 * whose `rule_id` equals `oldRoomId`, a copy of that rule (with `rule_id` set
 * to `newRoomId`) is added. The original rule is left in place.
 *
 * This is shared between the two ways a room can be upgraded:
 *   1. `POST /rooms/{roomId}/upgrade` (handled here, in `postRoomUpgrade`).
 *   2. A "manual" upgrade where the client creates the replacement room itself
 *      and then sends an `m.room.tombstone` event to the old room. That path
 *      flows through `putStateEvent` (src/handlers/room-events.ts), which must
 *      call `migrateRoomPushRules` whenever it persists an `m.room.tombstone`
 *      state event carrying a `replacement_room`. See SHARED-NEED note at the
 *      bottom of this file.
 */
export async function migrateRoomPushRules(
	storage: Storage,
	serverName: string,
	oldRoom: RoomState,
	oldRoomId: RoomId,
	newRoomId: RoomId,
): Promise<void> {
	const suffix = `:${serverName}`;
	const localUsers = new Set<string>();
	for (const [key, event] of oldRoom.state_events) {
		if (!key.startsWith("m.room.member\0")) continue;
		const userId = event.state_key;
		if (!userId || !userId.endsWith(suffix)) continue;
		const membership = (event.content as { membership?: string }).membership;
		if (membership === "join") localUsers.add(userId);
	}

	for (const userId of localUsers) {
		const raw = await storage.getGlobalAccountData(
			userId as never,
			"m.push_rules",
		);
		if (!raw) continue;

		const pushRules = raw as unknown as PushRulesContent;
		const roomRules = pushRules.global?.room;
		if (!Array.isArray(roomRules)) continue;

		const existing = roomRules.find((r) => r.rule_id === oldRoomId);
		if (!existing) continue;

		// Avoid duplicating if a rule for the new room already exists.
		if (roomRules.some((r) => r.rule_id === newRoomId)) continue;

		const copied: PushRule = {
			...existing,
			rule_id: newRoomId,
		};
		roomRules.push(copied);

		await storage.setGlobalAccountData(
			userId as never,
			"m.push_rules",
			raw as JsonObject,
		);
	}
}

/*
 * SHARED-NEED (manual room upgrade push-rule migration)
 * -----------------------------------------------------
 * Complement's TestPushRuleRoomUpgrade runs two sub-cases per scenario:
 *   - `useManualRoomUpgrade=false`: client calls POST /rooms/{id}/upgrade,
 *     which lands in `postRoomUpgrade` above and DOES migrate push rules.
 *   - `useManualRoomUpgrade=true` ("manually upgrading a room ..."): the client
 *     creates the replacement room itself, then sends `m.room.tombstone` to the
 *     old room via PUT /rooms/{id}/state/m.room.tombstone/. This path NEVER
 *     reaches `postRoomUpgrade`; it goes through `putStateEvent`
 *     (src/handlers/room-events.ts). With no hook there, push rules are never
 *     copied to the replacement room and the manual sub-case fails.
 *
 * Fix that cannot live in this file (per the edit-scope constraint): after
 * `putStateEvent` successfully persists an `m.room.tombstone` state event,
 * it must call the exported `migrateRoomPushRules` here. Concretely, in
 * src/handlers/room-events.ts `putStateEvent`, immediately after the
 * `await storage.setStateEvent(roomId, event, eventId)` line, add:
 *
 *   if (
 *     eventType === "m.room.tombstone" &&
 *     stateKey === "" &&
 *     typeof (newContent as { replacement_room?: unknown }).replacement_room ===
 *       "string"
 *   ) {
 *     await migrateRoomPushRules(
 *       storage,
 *       serverName,
 *       room,
 *       roomId as RoomId,
 *       (newContent as { replacement_room: string }).replacement_room as RoomId,
 *     );
 *   }
 *
 * (with `import { migrateRoomPushRules } from "./room-upgrade.ts";`). The
 * `room` value there is the old room's state returned by `requireJoinedRoom`,
 * which already contains every local joined member, so the helper resolves the
 * correct set of users.
 */
