import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { WhoAmIResponse, AuthType } from "../types/index.ts";
import type { UIAAResponse } from "../types/auth.ts";
import { badJson, forbidden } from "../errors.ts";
import { generateSessionId } from "../crypto.ts";

const UIAA_FLOWS: { stages: AuthType[] }[] = [{ stages: ["m.login.dummy"] }];

const MIN_PASSWORD_LENGTH = 8;

async function requireUIAA(
	storage: Storage,
	body: Record<string, unknown>,
): Promise<boolean> {
	const auth = body["auth"] as Record<string, unknown> | undefined;

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

	const sessionId = auth["session"] as string | undefined;
	if (!sessionId) throw badJson("Missing auth session");

	const uiaaSession = await storage.getUIAASession(sessionId);
	if (!uiaaSession) throw forbidden("Unknown session");

	if (auth["type"] === "m.login.dummy") {
		await storage.addUIAACompleted(sessionId, "m.login.dummy");
	} else {
		throw badJson(`Unsupported auth type: ${auth["type"]}`);
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
}

export function getWhoAmI(): Handler {
	return async (req) => {
		const body: WhoAmIResponse = {
			user_id: req.userId!,
			device_id: req.deviceId,
		};
		return { status: 200, body };
	};
}

export function postChangePassword(storage: Storage): Handler {
	return async (req) => {
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

		const newPassword = body["new_password"] as string | undefined;
		if (!newPassword) throw badJson("Missing 'new_password' field");
		if (newPassword.length < MIN_PASSWORD_LENGTH) {
			throw badJson(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			);
		}

		await storage.updatePassword(req.userId!, newPassword); // TODO: hash with argon2

		// logout_devices defaults to true
		const logoutDevices = body["logout_devices"] !== false;
		if (logoutDevices) {
			const currentToken = req.accessToken!;
			const sessions = await storage.getSessionsByUser(req.userId!);
			for (const session of sessions) {
				if (session.access_token !== currentToken) {
					await storage.deleteSession(session.access_token);
				}
			}
		}

		return { status: 200, body: {} };
	};
}

export function postDeactivate(storage: Storage): Handler {
	return async (req) => {
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

		await storage.deactivateUser(req.userId!);

		return { status: 200, body: { id_server_unbind_result: "no-support" } };
	};
}
