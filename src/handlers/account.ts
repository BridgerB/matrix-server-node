import { hashPassword } from "../crypto-utils.ts";
import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { WhoAmIResponse } from "../types/index.ts";
import { withUIAA } from "../uiaa.ts";

const MIN_PASSWORD_LENGTH = 8;

export const getWhoAmI = (): Handler => async (req) => ({
	status: 200,
	body: {
		user_id: req.userId as string,
		device_id: req.deviceId,
	} as WhoAmIResponse,
});

export const postChangePassword =
	(storage: Storage): Handler =>
	async (req) => {
		const body = req.body as Record<string, unknown>;

		const uiaaResponse = await withUIAA(storage, body);
		if (uiaaResponse) return uiaaResponse;

		const newPassword = body.new_password as string | undefined;
		if (!newPassword) throw badJson("Missing 'new_password' field");
		if (newPassword.length < MIN_PASSWORD_LENGTH)
			throw badJson(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			);

		const passwordHash = await hashPassword(newPassword);
		await storage.updatePassword(req.userId as string, passwordHash);

		const logoutDevices = body.logout_devices !== false;
		if (logoutDevices) {
			const currentToken = req.accessToken as string;
			const sessions = await storage.getSessionsByUser(req.userId as string);
			for (const session of sessions) {
				if (session.access_token !== currentToken) {
					await storage.deleteSession(session.access_token);
				}
			}
		}

		return { status: 200, body: {} };
	};

export const postDeactivate =
	(storage: Storage): Handler =>
	async (req) => {
		const body = req.body as Record<string, unknown>;

		const uiaaResponse = await withUIAA(storage, body);
		if (uiaaResponse) return uiaaResponse;

		await storage.deactivateUser(req.userId as string);

		return { status: 200, body: { id_server_unbind_result: "no-support" } };
	};
