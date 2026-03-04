import { badJson, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { DeviceId } from "../types/index.ts";
import { withUIAA } from "../uiaa.ts";

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

		const uiaaResponse = await withUIAA(storage, body);
		if (uiaaResponse) return uiaaResponse;

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

		const uiaaResponse = await withUIAA(storage, body);
		if (uiaaResponse) return uiaaResponse;

		for (const deviceId of deviceIds) {
			await storage.deleteDeviceSession(
				req.userId as string,
				deviceId as DeviceId,
			);
		}
		return { status: 200, body: {} };
	};
