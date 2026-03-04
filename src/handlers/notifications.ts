import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
import { pduToClientEvent } from "../events.ts";
import { getOrInitRules, evaluatePushRules } from "../push-rules.ts";

// =============================================================================
// GET /_matrix/client/v3/notifications
// =============================================================================

export function getNotifications(storage: Storage): Handler {
	return async (req) => {
		const userId = req.userId!;
		const fromStr = req.query.get("from");
		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10), 1), 100);
		const onlyHighlights = req.query.get("only") === "highlight";

		const userRules = await getOrInitRules(storage, userId);
		const profile = await storage.getProfile(userId);
		const displayName = profile?.displayname ?? undefined;

		const joinedRooms = await storage.getRoomsForUser(userId);

		// Collect recent events across all joined rooms
		const allEvents: {
			event: ReturnType<typeof pduToClientEvent>;
			roomId: string;
			streamPos: number;
			actions: unknown[];
			highlight: boolean;
		}[] = [];

		for (const roomId of joinedRooms) {
			const memberEvents = await storage.getMemberEvents(roomId);
			const memberCount = memberEvents.filter(
				(m) =>
					(m.event.content as Record<string, unknown>)["membership"] === "join",
			).length;

			const plEvent = await storage.getStateEvent(
				roomId,
				"m.room.power_levels",
				"",
			);
			const powerLevels = plEvent
				? (plEvent.event.content as unknown as RoomPowerLevelsContent)
				: undefined;

			const getSenderPl = (sender: UserId): number => {
				if (!powerLevels) return 0;
				return powerLevels.users?.[sender] ?? powerLevels.users_default ?? 0;
			};

			// Get recent events (up to 100 per room for notification scanning)
			const result = await storage.getEventsByRoom(roomId, 100, undefined, "b");
			for (const { event, eventId } of result.events) {
				if (event.sender === userId) continue;

				const evalResult = evaluatePushRules(userRules, {
					event,
					userId,
					displayName,
					memberCount,
					powerLevels,
					senderPowerLevel: getSenderPl(event.sender),
				});

				if (!evalResult.notify) continue;
				if (onlyHighlights && !evalResult.highlight) continue;

				// Build actions array matching the push rule actions
				const actions: unknown[] = ["notify"];
				if (evalResult.highlight) actions.push({ set_tweak: "highlight" });
				if (evalResult.sound)
					actions.push({ set_tweak: "sound", value: evalResult.sound });

				const timeline = await storage.getEventsByRoom(
					roomId,
					10000,
					undefined,
					"f",
				);
				const entry = timeline.events.find((e) => e.eventId === eventId);
				const streamPos = entry ? (result.end ?? 0) : 0;

				allEvents.push({
					event: pduToClientEvent(event, eventId),
					roomId,
					streamPos,
					actions,
					highlight: evalResult.highlight,
				});
			}
		}

		// Sort by stream position descending (most recent first)
		allEvents.sort((a, b) => b.streamPos - a.streamPos);

		// Apply pagination
		let filtered = allEvents;
		if (fromStr) {
			const fromPos = parseInt(fromStr, 10);
			filtered = allEvents.filter((e) => e.streamPos < fromPos);
		}

		const sliced = filtered.slice(0, limit);

		const notifications = sliced.map((e) => ({
			actions: e.actions,
			event: e.event,
			room_id: e.roomId,
			ts: e.event.origin_server_ts,
			read: false,
		}));

		const nextToken =
			sliced.length === limit && sliced.length > 0
				? String(sliced[sliced.length - 1]!.streamPos)
				: undefined;

		return {
			status: 200,
			body: {
				notifications,
				next_token: nextToken,
			},
		};
	};
}
