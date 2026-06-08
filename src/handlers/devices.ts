import { badJson, forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { DeviceId } from "../types/index.ts";
import { withUIAA } from "../uiaa.ts";

/**
 * Extract the localpart from a Matrix user identifier, which may be a full
 * user ID (`@alice:server`) or a bare localpart (`alice`).
 */
const localpartOf = (user: string): string => {
	if (user.startsWith("@")) {
		const colonIdx = user.indexOf(":");
		return colonIdx > 0 ? user.slice(1, colonIdx) : user.slice(1);
	}
	return user;
};

/**
 * Ensure that the user supplied in a UIA `m.login.password` identifier matches
 * the authenticated requester. Device deletion must be authorised by the device
 * owner, not by some other user who happens to know their own password. Returns
 * a 403 when the identifier names a different user.
 */
const assertUIAUserMatchesRequester = (
	body: Record<string, unknown>,
	requesterUserId: string,
): void => {
	const auth = body.auth as Record<string, unknown> | undefined;
	if (!auth) return;
	const identifier = auth.identifier as Record<string, unknown> | undefined;
	if (!identifier || identifier.type !== "m.id.user") return;
	const user = identifier.user;
	if (typeof user !== "string") return;
	if (localpartOf(user) !== localpartOf(requesterUserId)) {
		throw forbidden("Cannot authenticate as a different user");
	}
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

		// The UIA must be completed as the device owner. Reject (403) before
		// running UIA if a different user's identifier was supplied.
		assertUIAUserMatchesRequester(body, req.userId as string);

		const uiaaResponse = await withUIAA(storage, body, req.userId as string);
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

		assertUIAUserMatchesRequester(body, req.userId as string);

		const uiaaResponse = await withUIAA(storage, body, req.userId as string);
		if (uiaaResponse) return uiaaResponse;

		for (const deviceId of deviceIds) {
			await storage.deleteDeviceSession(
				req.userId as string,
				deviceId as DeviceId,
			);
		}
		return { status: 200, body: {} };
	};
