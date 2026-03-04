import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";
import type { PresenceState } from "../types/ephemeral.ts";
import { forbidden } from "../errors.ts";

export function getPresence(storage: Storage): Handler {
	return async (req) => {
		const userId = req.params["userId"]! as UserId;

		const data = await storage.getPresence(userId);
		if (!data) {
			return {
				status: 200,
				body: { presence: "offline" as PresenceState },
			};
		}

		const result: Record<string, unknown> = { presence: data.presence };
		if (data.status_msg) result["status_msg"] = data.status_msg;
		if (data.last_active_ts) {
			result["last_active_ago"] = Date.now() - data.last_active_ts;
		}
		return { status: 200, body: result };
	};
}

export function putPresence(storage: Storage): Handler {
	return async (req) => {
		const userId = req.params["userId"]! as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot set another user's presence");

		const body = req.body as Record<string, unknown>;
		const presence = body["presence"] as PresenceState;
		const statusMsg = body["status_msg"] as string | undefined;

		await storage.setPresence(userId, presence, statusMsg);
		return { status: 200, body: {} };
	};
}
