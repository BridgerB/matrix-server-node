import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId, RoomId, DeviceId } from "../types/index.ts";
import type { SyncResponse, JoinedRoom, InvitedRoom, LeftRoom, UnreadNotificationCounts } from "../types/sync.ts";
import type { ClientEvent, PDU } from "../types/events.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
import type { PushRulesContent } from "../types/push.ts";
import { pduToClientEvent } from "../events.ts";
import { getOrInitRules, evaluatePushRules } from "../push-rules.ts";
import { bundleAggregations } from "../relations.ts";

const TIMELINE_LIMIT = 20;
const MAX_TIMEOUT = 30000;

export function getSync(storage: Storage, _serverName: string): Handler {
  return async (req) => {
    const userId = req.userId!;
    const deviceId = req.deviceId!;
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
      ? await buildInitialSync(storage, userId, deviceId, nextBatch)
      : await buildIncrementalSync(storage, userId, deviceId, since, nextBatch, fullState);

    return { status: 200, body: response };
  };
}

async function buildInitialSync(
  storage: Storage,
  userId: UserId,
  deviceId: DeviceId,
  nextBatch: number,
): Promise<SyncResponse> {
  const userRooms = await storage.getRoomsForUserWithMembership(userId);

  const join: Record<RoomId, JoinedRoom> = {};
  const invite: Record<RoomId, InvitedRoom> = {};
  const userRules = await getOrInitRules(storage, userId);

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
      await bundleAggregations(storage, timelineClientEvents, userId);

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
        unread_notifications: await computeNotificationCounts(
          storage, roomId, userId, userRules, timelineEvents,
        ),
      };
    } else if (membership === "invite") {
      const stripped = await storage.getStrippedState(roomId);
      invite[roomId] = { invite_state: { events: stripped } };
    }
  }

  // Global account data
  const globalData = await storage.getAllGlobalAccountData(userId);
  const accountDataEvents = globalData.map((d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent);

  // Room account data + ephemeral for joined rooms
  const seenUsers = new Set<UserId>();
  for (const roomId of Object.keys(join)) {
    const roomData = await storage.getAllRoomAccountData(userId, roomId);
    if (roomData.length > 0) {
      const roomDataEvents = roomData.map((d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent);
      join[roomId]!.account_data = { events: roomDataEvents };
    }

    // Ephemeral: typing + receipts
    const ephemeralEvents: ClientEvent[] = [];

    const typingUsers = await storage.getTypingUsers(roomId as RoomId);
    ephemeralEvents.push({ type: "m.typing", content: { user_ids: typingUsers } } as unknown as ClientEvent);

    const receipts = await storage.getReceipts(roomId as RoomId);
    if (receipts.length > 0) {
      ephemeralEvents.push({ type: "m.receipt", content: buildReceiptContent(receipts) } as unknown as ClientEvent);
    }

    join[roomId]!.ephemeral = { events: ephemeralEvents };

    // Collect users for presence
    const members = await storage.getMemberEvents(roomId as RoomId);
    for (const m of members) {
      const membership = (m.event.content as Record<string, unknown>)["membership"];
      if (membership === "join" && m.event.state_key) {
        seenUsers.add(m.event.state_key as UserId);
      }
    }
  }

  // Presence for all room members
  const presenceEvents: ClientEvent[] = [];
  for (const uid of seenUsers) {
    const p = await storage.getPresence(uid);
    if (p) {
      const content: Record<string, unknown> = { presence: p.presence };
      if (p.status_msg) content["status_msg"] = p.status_msg;
      if (p.last_active_ts) content["last_active_ago"] = Date.now() - p.last_active_ts;
      presenceEvents.push({ type: "m.presence", content, sender: uid } as unknown as ClientEvent);
    }
  }

  // To-device messages
  const toDeviceEvents = await storage.getToDeviceMessages(userId, deviceId);
  if (toDeviceEvents.length > 0) {
    await storage.clearToDeviceMessages(userId, deviceId);
  }

  // E2EE key counts
  const otkCounts = await storage.getOneTimeKeyCounts(userId, deviceId);
  const fallbackKeyTypes = await storage.getFallbackKeyTypes(userId, deviceId);

  return {
    next_batch: String(nextBatch),
    account_data: accountDataEvents.length > 0 ? { events: accountDataEvents } : undefined,
    presence: presenceEvents.length > 0 ? { events: presenceEvents } : undefined,
    rooms: {
      join: Object.keys(join).length > 0 ? join : undefined,
      invite: Object.keys(invite).length > 0 ? invite : undefined,
    },
    to_device: toDeviceEvents.length > 0 ? { events: toDeviceEvents } : undefined,
    device_one_time_keys_count: otkCounts,
    device_unused_fallback_key_types: fallbackKeyTypes,
  };
}

async function buildIncrementalSync(
  storage: Storage,
  userId: UserId,
  deviceId: DeviceId,
  since: number,
  nextBatch: number,
  fullState: boolean,
): Promise<SyncResponse> {
  const userRooms = await storage.getRoomsForUserWithMembership(userId);

  const join: Record<RoomId, JoinedRoom> = {};
  const invite: Record<RoomId, InvitedRoom> = {};
  const leave: Record<RoomId, LeftRoom> = {};
  const seenUsers = new Set<UserId>();
  const userRules = await getOrInitRules(storage, userId);

  for (const { roomId, membership } of userRooms) {
    if (membership === "join") {
      const { events: newEvents, limited } = await storage.getEventsByRoomSince(roomId, since, TIMELINE_LIMIT);

      const timelineClientEvents = newEvents.map((e) => pduToClientEvent(e.event, e.eventId));
      await bundleAggregations(storage, timelineClientEvents, userId);

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

      // Ephemeral: typing + receipts
      const ephemeralEvents: ClientEvent[] = [];
      const typingUsers = await storage.getTypingUsers(roomId);
      ephemeralEvents.push({ type: "m.typing", content: { user_ids: typingUsers } } as unknown as ClientEvent);

      const receipts = await storage.getReceipts(roomId);
      if (receipts.length > 0) {
        ephemeralEvents.push({ type: "m.receipt", content: buildReceiptContent(receipts) } as unknown as ClientEvent);
      }

      // Always include joined rooms in incremental sync (for ephemeral data)
      if (timelineClientEvents.length > 0 || stateClientEvents.length > 0 || ephemeralEvents.length > 0) {
        // Use full recent timeline for notification counts
        const recentResult = await storage.getEventsByRoom(roomId, TIMELINE_LIMIT, undefined, "b");
        const recentEvents = recentResult.events.reverse();

        join[roomId] = {
          state: stateClientEvents.length > 0 ? { events: stateClientEvents } : undefined,
          timeline: {
            events: timelineClientEvents,
            limited: limited || undefined,
            prev_batch: prevBatch,
          },
          ephemeral: { events: ephemeralEvents },
          unread_notifications: await computeNotificationCounts(
            storage, roomId, userId, userRules, recentEvents,
          ),
        };
      }

      // Collect users for presence
      const members = await storage.getMemberEvents(roomId);
      for (const m of members) {
        const mem = (m.event.content as Record<string, unknown>)["membership"];
        if (mem === "join" && m.event.state_key) {
          seenUsers.add(m.event.state_key as UserId);
        }
      }
    } else if (membership === "invite") {
      const { events: newEvents } = await storage.getEventsByRoomSince(roomId, since, TIMELINE_LIMIT);
      const membershipChanged = newEvents.some(
        (e) => e.event.type === "m.room.member" && e.event.state_key === userId,
      );
      if (membershipChanged) {
        const stripped = await storage.getStrippedState(roomId);
        invite[roomId] = { invite_state: { events: stripped } };
      }
    } else if (membership === "leave" || membership === "ban") {
      const { events: newEvents, limited } = await storage.getEventsByRoomSince(roomId, since, TIMELINE_LIMIT);
      const membershipChanged = newEvents.some(
        (e) => e.event.type === "m.room.member" && e.event.state_key === userId,
      );
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

  // Presence for all room members
  const presenceEvents: ClientEvent[] = [];
  for (const uid of seenUsers) {
    const p = await storage.getPresence(uid);
    if (p) {
      const content: Record<string, unknown> = { presence: p.presence };
      if (p.status_msg) content["status_msg"] = p.status_msg;
      if (p.last_active_ts) content["last_active_ago"] = Date.now() - p.last_active_ts;
      presenceEvents.push({ type: "m.presence", content, sender: uid } as unknown as ClientEvent);
    }
  }

  // To-device messages
  const toDeviceEvents = await storage.getToDeviceMessages(userId, deviceId);
  if (toDeviceEvents.length > 0) {
    await storage.clearToDeviceMessages(userId, deviceId);
  }

  // E2EE key counts
  const otkCounts = await storage.getOneTimeKeyCounts(userId, deviceId);
  const fallbackKeyTypes = await storage.getFallbackKeyTypes(userId, deviceId);

  return {
    next_batch: String(nextBatch),
    presence: presenceEvents.length > 0 ? { events: presenceEvents } : undefined,
    rooms: {
      join: Object.keys(join).length > 0 ? join : undefined,
      invite: Object.keys(invite).length > 0 ? invite : undefined,
      leave: Object.keys(leave).length > 0 ? leave : undefined,
    },
    to_device: toDeviceEvents.length > 0 ? { events: toDeviceEvents } : undefined,
    device_one_time_keys_count: otkCounts,
    device_unused_fallback_key_types: fallbackKeyTypes,
  };
}

function buildReceiptContent(
  receipts: { eventId: string; receiptType: string; userId: string; ts: number }[],
): Record<string, unknown> {
  const content: Record<string, Record<string, Record<string, { ts: number }>>> = {};
  for (const r of receipts) {
    if (!content[r.eventId]) content[r.eventId] = {};
    if (!content[r.eventId]![r.receiptType]) content[r.eventId]![r.receiptType] = {};
    content[r.eventId]![r.receiptType]![r.userId] = { ts: r.ts };
  }
  return content;
}

async function computeNotificationCounts(
  storage: Storage,
  roomId: RoomId,
  userId: UserId,
  userRules: PushRulesContent,
  timelineEvents: { event: PDU; eventId: string }[],
): Promise<UnreadNotificationCounts> {
  // Get user's display name for contains_display_name condition
  const profile = await storage.getProfile(userId);
  const displayName = profile?.displayname ?? undefined;

  // Get room member count
  const memberEvents = await storage.getMemberEvents(roomId);
  const memberCount = memberEvents.filter(
    (m) => (m.event.content as Record<string, unknown>)["membership"] === "join",
  ).length;

  // Get power levels
  const plEvent = await storage.getStateEvent(roomId, "m.room.power_levels", "");
  const powerLevels = plEvent
    ? (plEvent.event.content as unknown as RoomPowerLevelsContent)
    : undefined;

  // Get sender power level helper
  const getSenderPl = (sender: UserId): number => {
    if (!powerLevels) return 0;
    return powerLevels.users?.[sender] ?? powerLevels.users_default ?? 0;
  };

  let notificationCount = 0;
  let highlightCount = 0;

  for (const { event } of timelineEvents) {
    if (event.sender === userId) continue;

    const result = evaluatePushRules(userRules, {
      event,
      userId,
      displayName,
      memberCount,
      powerLevels,
      senderPowerLevel: getSenderPl(event.sender),
    });

    if (result.notify) {
      notificationCount++;
      if (result.highlight) highlightCount++;
    }
  }

  return {
    notification_count: notificationCount,
    highlight_count: highlightCount,
  };
}
