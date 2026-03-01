import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, EventId } from "../types/index.ts";

export function postReceipt(storage: Storage): Handler {
  return async (req) => {
    const roomId = req.params["roomId"]! as RoomId;
    const receiptType = req.params["receiptType"]!;
    const eventId = req.params["eventId"]! as EventId;
    const userId = req.userId!;

    await storage.setReceipt(roomId, userId, eventId, receiptType, Date.now());
    return { status: 200, body: {} };
  };
}
