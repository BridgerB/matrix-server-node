import { generateSessionId } from "../crypto.ts";
import { badJson, forbidden } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UIAAResponse } from "../types/auth.ts";
import type { AuthType, WhoAmIResponse } from "../types/index.ts";

const UIAA_FLOWS: { stages: AuthType[] }[] = [{ stages: ["m.login.dummy"] }];

const MIN_PASSWORD_LENGTH = 8;

const requireUIAA = async (
	storage: Storage,
	body: Record<string, unknown>,
): Promise<boolean> => {
	const auth = body.auth as Record<string, unknown> | undefined;

	if (!auth) {
		const sessionId = generateSessionId();
		await storage.createUIAASession(sessionId);
		const uiaa: UIAAResponse = {
			flows: UIAA_FLOWS,
			params: {},
			session: sessionId,
		};
		throw Object.assign(new Error("UIAA"), { uiaaResponse: uiaa });
	}

	const sessionId = auth.session as string | undefined;
	if (!sessionId) throw badJson("Missing auth session");

	const uiaaSession = await storage.getUIAASession(sessionId);
	if (!uiaaSession) throw forbidden("Unknown session");

	if (auth.type === "m.login.dummy") {
		await storage.addUIAACompleted(sessionId, "m.login.dummy");
	} else {
		throw badJson(`Unsupported auth type: ${auth.type}`);
	}

	const updated = await storage.getUIAASession(sessionId);
	const allCompleted = UIAA_FLOWS.some((flow) =>
		flow.stages.every((stage) => updated?.completed.includes(stage)),
	);

	if (!allCompleted) {
		const uiaa: UIAAResponse = {
			flows: UIAA_FLOWS,
			params: {},
			session: sessionId,
			completed: updated?.completed as AuthType[],
		};
		throw Object.assign(new Error("UIAA"), { uiaaResponse: uiaa });
	}

	await storage.deleteUIAASession(sessionId);
	return true;
};

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

		try {
			await requireUIAA(storage, body);
		} catch (err: unknown) {
			if (err && typeof err === "object" && "uiaaResponse" in err) {
				return {
					status: 401,
					body: (err as { uiaaResponse: unknown }).uiaaResponse,
				};
			}
			throw err;
		}

		const newPassword = body.new_password as string | undefined;
		if (!newPassword) throw badJson("Missing 'new_password' field");
		if (newPassword.length < MIN_PASSWORD_LENGTH)
			throw badJson(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			);

		await storage.updatePassword(req.userId as string, newPassword); // TODO: hash with argon2

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

		try {
			await requireUIAA(storage, body);
		} catch (err: unknown) {
			if (err && typeof err === "object" && "uiaaResponse" in err) {
				return {
					status: 401,
					body: (err as { uiaaResponse: unknown }).uiaaResponse,
				};
			}
			throw err;
		}

		await storage.deactivateUser(req.userId as string);

		return { status: 200, body: { id_server_unbind_result: "no-support" } };
	};
