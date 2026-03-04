import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { UserId, DeviceId, KeyId } from "../../types/index.ts";
import { notFound } from "../../errors.ts";

// =============================================================================
// POST /_matrix/federation/v1/user/devices/:userId
// =============================================================================

export function postFederationUserDevices(storage: Storage): Handler {
	return async (req) => {
		const userId = req.params["userId"]! as UserId;

		const user = await storage.getUserById(userId);
		if (!user) throw notFound("User not found");

		const allDevices = await storage.getAllDevices(userId);
		const devices: {
			device_id: string;
			device_display_name?: string;
			keys: unknown;
		}[] = [];

		for (const device of allDevices) {
			const keys = await storage.getDeviceKeys(
				userId,
				device.device_id as DeviceId,
			);
			if (keys) {
				devices.push({
					device_id: device.device_id,
					device_display_name: device.display_name,
					keys,
				});
			}
		}

		return {
			status: 200,
			body: {
				user_id: userId,
				stream_id: 0,
				devices,
			},
		};
	};
}

// =============================================================================
// POST /_matrix/federation/v1/user/keys/query
// =============================================================================

export function postFederationKeysQuery(storage: Storage): Handler {
	return async (req) => {
		const body = (req.body ?? {}) as {
			device_keys?: Record<UserId, DeviceId[]>;
		};

		const deviceKeys: Record<UserId, Record<DeviceId, unknown>> = {};

		if (body.device_keys) {
			for (const [userId, deviceIds] of Object.entries(body.device_keys)) {
				deviceKeys[userId as UserId] = {};
				if (deviceIds.length === 0) {
					// All devices
					const allKeys = await storage.getAllDeviceKeys(userId as UserId);
					for (const [deviceId, keys] of Object.entries(allKeys)) {
						deviceKeys[userId as UserId]![deviceId as DeviceId] = keys;
					}
				} else {
					for (const deviceId of deviceIds) {
						const keys = await storage.getDeviceKeys(
							userId as UserId,
							deviceId,
						);
						if (keys) {
							deviceKeys[userId as UserId]![deviceId] = keys;
						}
					}
				}
			}
		}

		return {
			status: 200,
			body: { device_keys: deviceKeys },
		};
	};
}

// =============================================================================
// POST /_matrix/federation/v1/user/keys/claim
// =============================================================================

export function postFederationKeysClaim(storage: Storage): Handler {
	return async (req) => {
		const body = (req.body ?? {}) as {
			one_time_keys?: Record<UserId, Record<DeviceId, string>>;
		};

		const oneTimeKeys: Record<
			UserId,
			Record<DeviceId, Record<KeyId, unknown>>
		> = {};

		if (body.one_time_keys) {
			for (const [userId, devices] of Object.entries(body.one_time_keys)) {
				oneTimeKeys[userId as UserId] = {};
				for (const [deviceId, algorithm] of Object.entries(devices)) {
					const claimed = await storage.claimOneTimeKey(
						userId as UserId,
						deviceId as DeviceId,
						algorithm,
					);
					if (claimed) {
						oneTimeKeys[userId as UserId]![deviceId as DeviceId] = {
							[claimed.keyId]: claimed.key,
						} as Record<KeyId, unknown>;
					}
				}
			}
		}

		return {
			status: 200,
			body: { one_time_keys: oneTimeKeys },
		};
	};
}
