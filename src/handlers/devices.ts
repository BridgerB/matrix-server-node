import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { DeviceId, AuthType } from "../types/index.ts";
import type { UIAAResponse } from "../types/auth.ts";
import { notFound, badJson, forbidden } from "../errors.ts";
import { generateSessionId } from "../crypto.ts";

const UIAA_FLOWS: { stages: AuthType[] }[] = [{ stages: ["m.login.dummy"] }];

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

export function getDevices(storage: Storage): Handler {
	return async (req) => {
		const devices = await storage.getAllDevices(req.userId!);
		return { status: 200, body: { devices } };
	};
}

export function getDevice(storage: Storage): Handler {
	return async (req) => {
		const deviceId = req.params["deviceId"]! as DeviceId;
		const device = await storage.getDevice(req.userId!, deviceId);
		if (!device) throw notFound("Device not found");
		return { status: 200, body: device };
	};
}

export function putDevice(storage: Storage): Handler {
	return async (req) => {
		const deviceId = req.params["deviceId"]! as DeviceId;
		const body = req.body as Record<string, unknown>;

		const device = await storage.getDevice(req.userId!, deviceId);
		if (!device) throw notFound("Device not found");

		const displayName = body["display_name"] as string | undefined;
		if (displayName !== undefined) {
			await storage.updateDeviceDisplayName(req.userId!, deviceId, displayName);
		}

		return { status: 200, body: {} };
	};
}

export function deleteDevice(storage: Storage): Handler {
	return async (req) => {
		const deviceId = req.params["deviceId"]! as DeviceId;
		const body = req.body as Record<string, unknown>;

		const device = await storage.getDevice(req.userId!, deviceId);
		if (!device) throw notFound("Device not found");

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

		await storage.deleteDeviceSession(req.userId!, deviceId);
		return { status: 200, body: {} };
	};
}

export function deleteDevices(storage: Storage): Handler {
	return async (req) => {
		const body = req.body as Record<string, unknown>;
		const deviceIds = body["devices"] as string[] | undefined;
		if (!deviceIds || !Array.isArray(deviceIds)) {
			throw badJson("Missing 'devices' array");
		}

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

		for (const deviceId of deviceIds) {
			await storage.deleteDeviceSession(req.userId!, deviceId as DeviceId);
		}
		return { status: 200, body: {} };
	};
}
