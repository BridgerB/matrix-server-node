import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export function postLogout(storage: Storage): Handler {
	return async (req) => {
		await storage.deleteSession(req.accessToken as string);
		return { status: 200, body: {} };
	};
}

export function postLogoutAll(storage: Storage): Handler {
	return async (req) => {
		await storage.deleteAllSessions(req.userId as string);
		return { status: 200, body: {} };
	};
}
