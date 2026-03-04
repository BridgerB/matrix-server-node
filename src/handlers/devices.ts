import { generateSessionId } from "../crypto.ts";
import { badJson, forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UIAAResponse } from "../types/auth.ts";
import type { AuthType, DeviceId } from "../types/index.ts";

const UIAA_FLOWS: { stages: AuthType[] }[] = [{ stages: ["m.login.dummy"] }];

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

export const getDevices =
	(storage: Storage): Handler =>
	async (req) => {
		const devices = await storage.getAllDevices(req.userId as string);
		return { status: 200, body: { devices } };
	};

export const getDevice =
	(storage: Storage): Handler =>
	async (req) => {
		const deviceId = req.params.deviceId as DeviceId;
		const device = await storage.getDevice(req.userId as string, deviceId);
		if (!device) throw notFound("Device not found");
		return { status: 200, body: device };
	};

export const putDevice =
	(storage: Storage): Handler =>
	async (req) => {
		const deviceId = req.params.deviceId as DeviceId;
		const body = req.body as Record<string, unknown>;

		const device = await storage.getDevice(req.userId as string, deviceId);
		if (!device) throw notFound("Device not found");

		const displayName = body.display_name as string | undefined;
		if (displayName !== undefined) {
			await storage.updateDeviceDisplayName(
				req.userId as string,
				deviceId,
				displayName,
			);
		}

		return { status: 200, body: {} };
	};

export const deleteDevice =
	(storage: Storage): Handler =>
	async (req) => {
		const deviceId = req.params.deviceId as DeviceId;
		const body = req.body as Record<string, unknown>;

		const device = await storage.getDevice(req.userId as string, deviceId);
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

		await storage.deleteDeviceSession(req.userId as string, deviceId);
		return { status: 200, body: {} };
	};

export const deleteDevices =
	(storage: Storage): Handler =>
	async (req) => {
		const body = req.body as Record<string, unknown>;
		const deviceIds = body.devices as string[] | undefined;
		if (!deviceIds || !Array.isArray(deviceIds))
			throw badJson("Missing 'devices' array");

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
			await storage.deleteDeviceSession(
				req.userId as string,
				deviceId as DeviceId,
			);
		}
		return { status: 200, body: {} };
	};
