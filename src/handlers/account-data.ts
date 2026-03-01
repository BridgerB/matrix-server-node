import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId, RoomId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";
import { forbidden, notFound, badJson } from "../errors.ts";

const FORBIDDEN_TYPES = new Set(["m.fully_read", "m.push_rules"]);

// =============================================================================
// GLOBAL ACCOUNT DATA
// =============================================================================

export function getGlobalAccountData(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot access another user's account data");

    const type = req.params["type"]!;
    const data = await storage.getGlobalAccountData(userId, type);
    if (!data) throw notFound("Account data not found");
    return { status: 200, body: data };
  };
}

export function putGlobalAccountData(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot set another user's account data");

    const type = req.params["type"]!;
    if (FORBIDDEN_TYPES.has(type)) {
      throw badJson(`Cannot set ${type} via this endpoint`);
    }

    const content = req.body as JsonObject;
    await storage.setGlobalAccountData(userId, type, content);
    return { status: 200, body: {} };
  };
}

// =============================================================================
// ROOM ACCOUNT DATA
// =============================================================================

export function getRoomAccountData(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot access another user's account data");

    const roomId = req.params["roomId"]! as RoomId;
    const type = req.params["type"]!;
    const data = await storage.getRoomAccountData(userId, roomId, type);
    if (!data) throw notFound("Account data not found");
    return { status: 200, body: data };
  };
}

export function putRoomAccountData(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot set another user's account data");

    const roomId = req.params["roomId"]! as RoomId;
    const type = req.params["type"]!;
    if (FORBIDDEN_TYPES.has(type)) {
      throw badJson(`Cannot set ${type} via this endpoint`);
    }

    const content = req.body as JsonObject;
    await storage.setRoomAccountData(userId, roomId, type, content);
    return { status: 200, body: {} };
  };
}

// =============================================================================
// TAGS (stored as m.tag room account data)
// =============================================================================

export function getTags(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot access another user's tags");

    const roomId = req.params["roomId"]! as RoomId;
    const data = await storage.getRoomAccountData(userId, roomId, "m.tag");
    const tags = data ? (data as Record<string, unknown>)["tags"] ?? {} : {};
    return { status: 200, body: { tags } };
  };
}

export function putTag(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot set another user's tags");

    const roomId = req.params["roomId"]! as RoomId;
    const tag = req.params["tag"]!;

    if (Buffer.byteLength(tag, "utf-8") > 255) {
      throw badJson("Tag name exceeds 255 bytes");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Read existing tags
    const existing = await storage.getRoomAccountData(userId, roomId, "m.tag");
    const tags = existing ? { ...(existing as Record<string, unknown>)["tags"] as Record<string, unknown> ?? {} } : {};

    // Set tag
    const tagData: Record<string, unknown> = {};
    if (body["order"] !== undefined) tagData["order"] = body["order"];
    tags[tag] = tagData;

    await storage.setRoomAccountData(userId, roomId, "m.tag", { tags } as JsonObject);
    return { status: 200, body: {} };
  };
}

export function deleteTag(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]! as UserId;
    if (req.userId !== userId) throw forbidden("Cannot delete another user's tags");

    const roomId = req.params["roomId"]! as RoomId;
    const tag = req.params["tag"]!;

    const existing = await storage.getRoomAccountData(userId, roomId, "m.tag");
    if (!existing) return { status: 200, body: {} };

    const tags = { ...(existing as Record<string, unknown>)["tags"] as Record<string, unknown> ?? {} };
    delete tags[tag];

    await storage.setRoomAccountData(userId, roomId, "m.tag", { tags } as JsonObject);
    return { status: 200, body: {} };
  };
}
