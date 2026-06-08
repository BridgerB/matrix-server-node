import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";

/** MSC3890: per-device local notification settings, removed when the device goes. */
const LOCAL_NOTIFICATION_SETTINGS_PREFIX =
	"org.matrix.msc3890.local_notification_settings.";

export const postLogout =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId | undefined;
		const deviceId = req.deviceId;
		await storage.deleteSession(req.accessToken as string);
		// MSC3890: logging out a device removes its local notification settings.
		if (userId && deviceId) {
			await storage.deleteGlobalAccountData(
				userId,
				LOCAL_NOTIFICATION_SETTINGS_PREFIX + deviceId,
			);
		}
		return { status: 200, body: {} };
	};

export const postLogoutAll =
	(storage: Storage): Handler =>
	async (req) => {
		await storage.deleteAllSessions(req.userId as string);
		return { status: 200, body: {} };
	};
