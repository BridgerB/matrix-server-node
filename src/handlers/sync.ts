import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId, RoomId } from "../types/index.ts";
import type { SyncResponse, JoinedRoom, InvitedRoom, LeftRoom } from "../types/sync.ts";
import type { ClientEvent } from "../types/events.ts";
import { pduToClientEvent } from "../events.ts";

const TIMELINE_LIMIT = 20;
const MAX_TIMEOUT = 30000;

export function getSync(storage: Storage, _serverName: string): Handler {
  return async (req) => {
    const userId = req.userId!;
    const sinceStr = req.query.get("since");
    const since = sinceStr !== null ? parseInt(sinceStr, 10) : undefined;
    const timeout = Math.min(
      Math.max(parseInt(req.query.get("timeout") ?? "0", 10), 0),
      MAX_TIMEOUT,
    );
    const fullState = req.query.get("full_state") === "true";

    // Long-poll: wait for new events if incremental sync
    if (since !== undefined && timeout > 0) {
      await storage.waitForEvents(since, timeout);
    }

    const nextBatch = await storage.getStreamPosition();

    const response: SyncResponse = since === undefined
      ? await buildInitialSync(storage, userId, nextBatch)
      : await buildIncrementalSync(storage, userId, since, nextBatch, fullState);

    return { status: 200, body: response };
  };
}

async function buildInitialSync(
  storage: Storage,
  userId: UserId,
  nextBatch: number,
): Promise<SyncResponse> {
  const userRooms = await storage.getRoomsForUserWithMembership(userId);

  const join: Record<RoomId, JoinedRoom> = {};
  const invite: Record<RoomId, InvitedRoom> = {};

  for (const { roomId, membership } of userRooms) {
    if (membership === "join") {
      // Get timeline (most recent events, backwards)
      const result = await storage.getEventsByRoom(roomId, TIMELINE_LIMIT, undefined, "b");
      const timelineEvents = result.events.reverse();
      const timelineEventIds = new Set(timelineEvents.map((e) => e.eventId));

      // Get state events not already in timeline
      const allState = await storage.getAllState(roomId);
      const stateEvents = allState
        .filter((e) => !timelineEventIds.has(e.eventId))
        .map((e) => pduToClientEvent(e.event, e.eventId));

      const timelineClientEvents = timelineEvents.map((e) => pduToClientEvent(e.event, e.eventId));

      // Check if timeline is limited
      const totalEvents = await storage.getEventsByRoom(roomId, TIMELINE_LIMIT + 1, undefined, "b");
      const limited = totalEvents.events.length > TIMELINE_LIMIT;

      const prevBatch = limited && result.end !== undefined
        ? String(result.end)
        : undefined;

      join[roomId] = {
        state: stateEvents.length > 0 ? { events: stateEvents } : undefined,
        timeline: {
          events: timelineClientEvents,
          limited: limited || undefined,
          prev_batch: prevBatch,
        },
      };
    } else if (membership === "invite") {
      const stripped = await storage.getStrippedState(roomId);
      invite[roomId] = { invite_state: { events: stripped } };
    }
  }

  return {
    next_batch: String(nextBatch),
    rooms: {
      join: Object.keys(join).length > 0 ? join : undefined,
      invite: Object.keys(invite).length > 0 ? invite : undefined,
    },
  };
}

async function buildIncrementalSync(
  storage: Storage,
  userId: UserId,
  since: number,
  nextBatch: number,
  fullState: boolean,
): Promise<SyncResponse> {
  if (nextBatch <= since && !fullState) {
    return { next_batch: String(nextBatch) };
  }

  const userRooms = await storage.getRoomsForUserWithMembership(userId);

  const join: Record<RoomId, JoinedRoom> = {};
  const invite: Record<RoomId, InvitedRoom> = {};
  const leave: Record<RoomId, LeftRoom> = {};

  for (const { roomId, membership } of userRooms) {
    const { events: newEvents, limited } = await storage.getEventsByRoomSince(roomId, since, TIMELINE_LIMIT);

    const userMemberEvents = newEvents.filter(
      (e) => e.event.type === "m.room.member" && e.event.state_key === userId,
    );
    const membershipChanged = userMemberEvents.length > 0;

    if (newEvents.length === 0 && !fullState) continue;

    if (membership === "join") {
      const timelineClientEvents = newEvents.map((e) => pduToClientEvent(e.event, e.eventId));

      let stateClientEvents: ClientEvent[] = [];
      if (fullState) {
        const allState = await storage.getAllState(roomId);
        const timelineIds = new Set(newEvents.map((e) => e.eventId));
        stateClientEvents = allState
          .filter((e) => !timelineIds.has(e.eventId))
          .map((e) => pduToClientEvent(e.event, e.eventId));
      }

      const prevBatch = limited && newEvents.length > 0
        ? String(newEvents[0]!.streamPos - 1)
        : undefined;

      if (timelineClientEvents.length > 0 || stateClientEvents.length > 0) {
        join[roomId] = {
          state: stateClientEvents.length > 0 ? { events: stateClientEvents } : undefined,
          timeline: {
            events: timelineClientEvents,
            limited: limited || undefined,
            prev_batch: prevBatch,
          },
        };
      }
    } else if (membership === "invite") {
      if (membershipChanged) {
        const stripped = await storage.getStrippedState(roomId);
        invite[roomId] = { invite_state: { events: stripped } };
      }
    } else if (membership === "leave" || membership === "ban") {
      if (membershipChanged) {
        const timelineClientEvents = newEvents.map((e) => pduToClientEvent(e.event, e.eventId));
        leave[roomId] = {
          timeline: {
            events: timelineClientEvents,
            limited: limited || undefined,
          },
        };
      }
    }
  }

  return {
    next_batch: String(nextBatch),
    rooms: {
      join: Object.keys(join).length > 0 ? join : undefined,
      invite: Object.keys(invite).length > 0 ? invite : undefined,
      leave: Object.keys(leave).length > 0 ? leave : undefined,
    },
  };
}
