import { pduToClientEvent } from "./events.ts";
import type { Storage } from "./storage/interface.ts";
import type { ClientEvent, PDU, UnsignedData } from "./types/events.ts";
import type { EventId, UserId } from "./types/identifiers.ts";
import type { JsonValue } from "./types/json.ts";

/**
 * Extract relation info from an event's content and store it.
 * Call this after storing an event to index its relation.
 */
export const indexRelation = async (
	storage: Storage,
	event: PDU,
	eventId: EventId,
): Promise<void> => {
	const relatesTo = (event.content as Record<string, unknown>)[
		"m.relates_to"
	] as { rel_type?: string; event_id?: string; key?: string } | undefined;

	if (!relatesTo?.rel_type || !relatesTo?.event_id) return;

	await storage.storeRelation(
		eventId,
		event.room_id,
		relatesTo.rel_type,
		relatesTo.event_id as EventId,
		relatesTo.key,
	);
};

/**
 * Enrich an array of client events with bundled aggregations (unsigned.m.relations).
 * Handles reactions (m.annotation), edits (m.replace), and threads (m.thread).
 */
export const bundleAggregations = async (
	storage: Storage,
	events: ClientEvent[],
	userId: UserId,
): Promise<void> => {
	for (const event of events) {
		const relations: Record<string, JsonValue> = {};

		const annotations = await storage.getAnnotationCounts(event.event_id);
		if (annotations.length > 0) {
			relations["m.annotation"] = {
				chunk: annotations.map(({ type, key, count }) => ({
					type,
					key,
					count,
				})),
			};
		}

		const latestEdit = await storage.getLatestEdit(
			event.event_id,
			event.sender,
		);
		if (latestEdit) {
			const { event_id, origin_server_ts, sender } = pduToClientEvent(
				latestEdit.event,
				latestEdit.eventId,
			);
			relations["m.replace"] = {
				event_id,
				origin_server_ts,
				sender,
			};
		}

		const threadSummary = await storage.getThreadSummary(
			event.event_id,
			userId,
		);
		if (threadSummary) {
			const latestThreadEvent = pduToClientEvent(
				threadSummary.latestEvent.event,
				threadSummary.latestEvent.eventId,
			);
			relations["m.thread"] = {
				latest_event: latestThreadEvent as unknown as JsonValue,
				count: threadSummary.count,
				current_user_participated: threadSummary.currentUserParticipated,
			};
		}

		if (Object.keys(relations).length > 0) {
			event.unsigned ??= {} as UnsignedData;
			event.unsigned["m.relations"] = relations;
		}
	}
};
