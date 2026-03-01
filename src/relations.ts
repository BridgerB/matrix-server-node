import type { Storage } from "./storage/interface.ts";
import type { PDU, ClientEvent, UnsignedData } from "./types/events.ts";
import type { UserId, EventId } from "./types/identifiers.ts";
import type { JsonValue } from "./types/json.ts";
import { pduToClientEvent } from "./events.ts";

// =============================================================================
// RELATION INDEXING
// =============================================================================

/**
 * Extract relation info from an event's content and store it.
 * Call this after storing an event to index its relation.
 */
export async function indexRelation(storage: Storage, event: PDU, eventId: EventId): Promise<void> {
  const relatesTo = (event.content as Record<string, unknown>)["m.relates_to"] as
    | { rel_type?: string; event_id?: string; key?: string }
    | undefined;

  if (!relatesTo?.rel_type || !relatesTo?.event_id) return;

  await storage.storeRelation(
    eventId,
    event.room_id,
    relatesTo.rel_type,
    relatesTo.event_id as EventId,
    relatesTo.key,
  );
}

// =============================================================================
// BUNDLED AGGREGATIONS
// =============================================================================

/**
 * Enrich an array of client events with bundled aggregations (unsigned.m.relations).
 * Handles reactions (m.annotation), edits (m.replace), and threads (m.thread).
 */
export async function bundleAggregations(
  storage: Storage,
  events: ClientEvent[],
  userId: UserId,
): Promise<void> {
  for (const event of events) {
    const relations: Record<string, JsonValue> = {};

    // Annotations (reactions) — grouped counts
    const annotations = await storage.getAnnotationCounts(event.event_id);
    if (annotations.length > 0) {
      relations["m.annotation"] = {
        chunk: annotations.map((a) => ({ type: a.type, key: a.key, count: a.count })),
      };
    }

    // Edits (m.replace) — latest edit by original sender
    const latestEdit = await storage.getLatestEdit(event.event_id, event.sender);
    if (latestEdit) {
      const editEvent = pduToClientEvent(latestEdit.event, latestEdit.eventId);
      relations["m.replace"] = {
        event_id: editEvent.event_id,
        origin_server_ts: editEvent.origin_server_ts,
        sender: editEvent.sender,
      };
    }

    // Thread summary
    const threadSummary = await storage.getThreadSummary(event.event_id, userId);
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
      if (!event.unsigned) event.unsigned = {} as UnsignedData;
      event.unsigned["m.relations"] = relations;
    }
  }
}
