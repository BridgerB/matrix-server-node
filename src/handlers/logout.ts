import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export const postLogout =
	(storage: Storage): Handler =>
	async (req) => {
		await storage.deleteSession(req.accessToken as string);
		return { status: 200, body: {} };
	};

export const postLogoutAll =
	(storage: Storage): Handler =>
	async (req) => {
		await storage.deleteAllSessions(req.userId as string);
		return { status: 200, body: {} };
	};
