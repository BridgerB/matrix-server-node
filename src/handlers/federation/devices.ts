import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { DeviceId, KeyId, UserId } from "../../types/index.ts";
import { queryDeviceKeys } from "../e2ee.ts";

export const postFederationUserDevices =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;

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

export const postFederationKeysQuery =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			device_keys?: Record<UserId, DeviceId[]>;
		};

		const deviceKeys: Record<UserId, Record<DeviceId, unknown>> = {};

		if (body.device_keys) {
			const result = await queryDeviceKeys(storage, body.device_keys);
			for (const userId of Object.keys(body.device_keys)) {
				deviceKeys[userId as UserId] = result[userId as UserId] ?? {};
			}
		}

		return {
			status: 200,
			body: { device_keys: deviceKeys },
		};
	};

export const postFederationKeysClaim =
	(storage: Storage): Handler =>
	async (req) => {
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
						(
							oneTimeKeys[userId as UserId] as Record<
								DeviceId,
								Record<KeyId, unknown>
							>
						)[deviceId as DeviceId] = {
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
