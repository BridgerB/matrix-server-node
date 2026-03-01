import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { JsonObject } from "../types/json.ts";
import type { CreateRoomRequest } from "../types/room-operations.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
import type { RoomState } from "../types/internal.ts";
import { generateRoomId } from "../crypto.ts";
import { buildEvent, selectAuthEvents, checkEventAuth, getMembership } from "../events.ts";
import { badJson, forbidden, roomNotFound, missingParam, notFound } from "../errors.ts";

// =============================================================================
// HELPERS
// =============================================================================

interface EventContext {
  roomState: RoomState;
  depth: number;
  prevEvents: string[];
}

async function sendStateEvent(
  storage: Storage,
  serverName: string,
  ctx: EventContext,
  sender: string,
  type: string,
  stateKey: string,
  content: JsonObject,
): Promise<string> {
  const authEvents = selectAuthEvents(type, stateKey, ctx.roomState, sender);
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
  });

  checkEventAuth(event, eventId, ctx.roomState);
  await storage.setStateEvent(ctx.roomState.room_id, event, eventId);

  // Advance context
  ctx.depth++;
  ctx.prevEvents = [eventId];
  ctx.roomState.depth = ctx.depth;
  ctx.roomState.forward_extremities = [eventId];

  return eventId;
}

// =============================================================================
// POST /createRoom
// =============================================================================

export function postCreateRoom(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const body = (req.body ?? {}) as CreateRoomRequest;
    const userId = req.userId!;
    const roomVersion = body.room_version ?? "11";
    const roomId = generateRoomId(serverName);

    // Determine preset
    let preset = body.preset;
    if (!preset) {
      preset = body.visibility === "public" ? "public_chat" : "private_chat";
    }

    // Initialize room
    const roomState: RoomState = {
      room_id: roomId,
      room_version: roomVersion,
      state_events: new Map(),
      depth: 0,
      forward_extremities: [],
    };
    await storage.createRoom(roomState);

    const ctx: EventContext = { roomState, depth: 0, prevEvents: [] };

    // 1. m.room.create
    const createContent: JsonObject = { room_version: roomVersion };
    if (body.creation_content) {
      Object.assign(createContent, body.creation_content);
    }
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.create", "", createContent);

    // 2. m.room.member for creator
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.member", userId, {
      membership: "join",
    });

    // 3. m.room.power_levels
    const plContent: RoomPowerLevelsContent = {
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
        plContent.users![invitee] = 100;
      }
    }
    if (body.power_level_content_override) {
      Object.assign(plContent, body.power_level_content_override);
    }
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.power_levels", "", plContent as unknown as JsonObject);

    // 4. m.room.join_rules
    const joinRule = preset === "public_chat" ? "public" : "invite";
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.join_rules", "", {
      join_rule: joinRule,
    });

    // 5. m.room.history_visibility
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.history_visibility", "", {
      history_visibility: "shared",
    });

    // 6. m.room.guest_access
    await sendStateEvent(storage, serverName, ctx, userId, "m.room.guest_access", "", {
      guest_access: "forbidden",
    });

    // 7. initial_state
    if (body.initial_state) {
      for (const stateInput of body.initial_state) {
        await sendStateEvent(
          storage, serverName, ctx, userId,
          stateInput.type, stateInput.state_key ?? "", stateInput.content,
        );
      }
    }

    // 8. m.room.name
    if (body.name) {
      await sendStateEvent(storage, serverName, ctx, userId, "m.room.name", "", {
        name: body.name,
      });
    }

    // 9. m.room.topic
    if (body.topic) {
      await sendStateEvent(storage, serverName, ctx, userId, "m.room.topic", "", {
        topic: body.topic,
      });
    }

    // 10. Invites
    if (body.invite) {
      for (const invitee of body.invite) {
        await sendStateEvent(storage, serverName, ctx, userId, "m.room.member", invitee, {
          membership: "invite",
        });
      }
    }

    // 11. Room alias
    if (body.room_alias_name) {
      const roomAlias = `#${body.room_alias_name}:${serverName}`;
      const existing = await storage.getRoomByAlias(roomAlias);
      if (existing) throw badJson(`Room alias ${roomAlias} already exists`);
      await storage.createRoomAlias(roomAlias, roomId, [serverName], userId);
      await sendStateEvent(storage, serverName, ctx, userId, "m.room.canonical_alias", "", {
        alias: roomAlias,
      });
    }

    // 12. Directory visibility
    if (body.visibility === "public") {
      await storage.setRoomVisibility(roomId, "public");
    }

    return { status: 200, body: { room_id: roomId } };
  };
}

// =============================================================================
// GET /joined_rooms
// =============================================================================

export function getJoinedRooms(storage: Storage): Handler {
  return async (req) => {
    const rooms = await storage.getRoomsForUser(req.userId!);
    return { status: 200, body: { joined_rooms: rooms } };
  };
}

// =============================================================================
// MEMBERSHIP OPERATIONS
// =============================================================================

async function sendMembershipEvent(
  storage: Storage,
  serverName: string,
  roomId: string,
  sender: string,
  targetUserId: string,
  membership: string,
  reason?: string,
): Promise<string> {
  const room = await storage.getRoom(roomId);
  if (!room) throw roomNotFound();

  const content: JsonObject = { membership };
  if (reason) content["reason"] = reason;

  const ctx: EventContext = {
    roomState: room,
    depth: room.depth,
    prevEvents: [...room.forward_extremities],
  };

  return sendStateEvent(storage, serverName, ctx, sender, "m.room.member", targetUserId, content);
}

export function postJoin(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomIdOrAlias = req.params["roomIdOrAlias"] ?? req.params["roomId"];
    if (!roomIdOrAlias) throw badJson("Missing room ID or alias");

    let roomId: string;
    if (roomIdOrAlias.startsWith("#")) {
      const resolved = await storage.getRoomByAlias(roomIdOrAlias);
      if (!resolved) throw notFound(`Room alias ${roomIdOrAlias} not found`);
      roomId = resolved.room_id;
    } else {
      roomId = roomIdOrAlias;
    }

    await sendMembershipEvent(storage, serverName, roomId, req.userId!, req.userId!, "join");
    return { status: 200, body: { room_id: roomId } };
  };
}

export function postLeave(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]!;
    const body = (req.body ?? {}) as { reason?: string };
    await sendMembershipEvent(storage, serverName, roomId, req.userId!, req.userId!, "leave", body.reason);
    return { status: 200, body: {} };
  };
}

export function postInvite(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]!;
    const body = req.body as { user_id?: string; reason?: string } | undefined;
    if (!body?.user_id) throw missingParam("Missing 'user_id'");
    await sendMembershipEvent(storage, serverName, roomId, req.userId!, body.user_id, "invite", body.reason);
    return { status: 200, body: {} };
  };
}

export function postKick(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]!;
    const body = req.body as { user_id?: string; reason?: string } | undefined;
    if (!body?.user_id) throw missingParam("Missing 'user_id'");
    await sendMembershipEvent(storage, serverName, roomId, req.userId!, body.user_id, "leave", body.reason);
    return { status: 200, body: {} };
  };
}

export function postBan(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]!;
    const body = req.body as { user_id?: string; reason?: string } | undefined;
    if (!body?.user_id) throw missingParam("Missing 'user_id'");
    await sendMembershipEvent(storage, serverName, roomId, req.userId!, body.user_id, "ban", body.reason);
    return { status: 200, body: {} };
  };
}

export function postUnban(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]!;
    const body = req.body as { user_id?: string; reason?: string } | undefined;
    if (!body?.user_id) throw missingParam("Missing 'user_id'");

    const room = await storage.getRoom(roomId);
    if (!room) throw roomNotFound();
    const currentMembership = getMembership(room, body.user_id);
    if (currentMembership !== "ban") throw forbidden("User is not banned");

    await sendMembershipEvent(storage, serverName, roomId, req.userId!, body.user_id, "leave", body.reason);
    return { status: 200, body: {} };
  };
}
