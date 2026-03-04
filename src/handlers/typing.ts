import { forbidden } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, UserId } from "../types/index.ts";

export function putTyping(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.params.userId as UserId;

		if (req.userId !== userId)
			throw forbidden("Cannot set typing for another user");

		const body = req.body as Record<string, unknown>;
		const typing = body.typing === true;
		const timeout = typeof body.timeout === "number" ? body.timeout : undefined;

		await storage.setTyping(roomId, userId, typing, timeout);
		return { status: 200, body: {} };
	};
}
