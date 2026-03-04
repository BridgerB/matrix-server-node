import { badJson, missingParam } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { Pusher } from "../types/push.ts";

// =============================================================================
// GET /_matrix/client/v3/pushers
// =============================================================================

export function getPushers(storage: Storage): Handler {
	return async (req) => {
		const userId = req.userId as string;
		const pushers = await storage.getPushers(userId);
		return { status: 200, body: { pushers } };
	};
}

// =============================================================================
// POST /_matrix/client/v3/pushers/set
// =============================================================================

export function postPushersSet(storage: Storage): Handler {
	return async (req) => {
		const userId = req.userId as string;
		const body = (req.body ?? {}) as Partial<Pusher>;

		if (!body.pushkey) throw missingParam("pushkey");
		if (!body.app_id) throw missingParam("app_id");

		// kind=null means delete
		if (body.kind === null) {
			await storage.deletePusher(userId, body.app_id, body.pushkey);
			return { status: 200, body: {} };
		}

		if (!body.kind) throw missingParam("kind");
		if (!body.app_display_name) throw missingParam("app_display_name");
		if (!body.device_display_name) throw missingParam("device_display_name");
		if (!body.lang) throw missingParam("lang");
		if (!body.data) throw missingParam("data");

		if (body.kind !== "http" && body.kind !== "email") {
			throw badJson("kind must be 'http', 'email', or null");
		}

		if (body.kind === "http" && !body.data.url) {
			throw badJson("HTTP pushers require data.url");
		}

		const pusher: Pusher = {
			pushkey: body.pushkey,
			kind: body.kind,
			app_id: body.app_id,
			app_display_name: body.app_display_name,
			device_display_name: body.device_display_name,
			lang: body.lang,
			data: body.data,
			profile_tag: body.profile_tag,
		};

		// If not appending, remove this pushkey+app_id from all users
		if (!body.append) {
			await storage.deletePusherByKey(body.app_id, body.pushkey);
		}

		await storage.setPusher(userId, pusher);
		return { status: 200, body: {} };
	};
}
