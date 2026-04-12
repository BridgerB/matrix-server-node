import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	DeviceKeys,
	KeysClaimRequest,
	KeysQueryRequest,
	KeysUploadRequest,
} from "../types/e2ee.ts";
import type { DeviceId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const postKeysUpload =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const deviceId = req.deviceId as DeviceId;
		const body = (req.body ?? {}) as KeysUploadRequest;

		if (body.device_keys) {
			if (
				body.device_keys.user_id !== userId ||
				body.device_keys.device_id !== deviceId
			) {
				throw badJson(
					"device_keys user_id/device_id must match authenticated user",
				);
			}
			await storage.setDeviceKeys(userId, deviceId, body.device_keys);
		}

		if (body.one_time_keys && Object.keys(body.one_time_keys).length > 0)
			await storage.addOneTimeKeys(userId, deviceId, body.one_time_keys);

		if (body.fallback_keys && Object.keys(body.fallback_keys).length > 0) {
			await storage.setFallbackKeys(userId, deviceId, body.fallback_keys);
		}

		const counts = await storage.getOneTimeKeyCounts(userId, deviceId);
		return { status: 200, body: { one_time_key_counts: counts } };
	};

export const queryDeviceKeys = async (
	storage: Storage,
	deviceKeysRequest: Record<string, string[]>,
): Promise<Record<UserId, Record<DeviceId, DeviceKeys>>> => {
	const deviceKeys: Record<UserId, Record<DeviceId, DeviceKeys>> = {};
	for (const [targetUserId, deviceIds] of Object.entries(deviceKeysRequest)) {
		if (deviceIds.length === 0) {
			const allKeys = await storage.getAllDeviceKeys(targetUserId as UserId);
			if (Object.keys(allKeys).length > 0)
				deviceKeys[targetUserId as UserId] = allKeys;
		} else {
			const userDeviceKeys: Record<DeviceId, DeviceKeys> = {};
			for (const did of deviceIds) {
				const keys = await storage.getDeviceKeys(targetUserId as UserId, did);
				if (keys) userDeviceKeys[did] = keys;
			}
			if (Object.keys(userDeviceKeys).length > 0)
				deviceKeys[targetUserId as UserId] = userDeviceKeys;
		}
	}
	return deviceKeys;
};

export const postKeysQuery =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as KeysQueryRequest;
		if (!body.device_keys) throw badJson("Missing device_keys field");

		const deviceKeys = await queryDeviceKeys(storage, body.device_keys);

		return { status: 200, body: { device_keys: deviceKeys } };
	};

export const postKeysClaim =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as KeysClaimRequest;
		if (!body.one_time_keys) throw badJson("Missing one_time_keys field");

		const oneTimeKeys: Record<
			UserId,
			Record<DeviceId, Record<string, string | JsonObject>>
		> = {};

		for (const [targetUserId, devices] of Object.entries(body.one_time_keys)) {
			for (const [targetDeviceId, algorithm] of Object.entries(devices)) {
				const claimed = await storage.claimOneTimeKey(
					targetUserId as UserId,
					targetDeviceId as DeviceId,
					algorithm,
				);
				if (claimed) {
					oneTimeKeys[targetUserId as UserId] ??= {} as Record<
						DeviceId,
						Record<string, string | JsonObject>
					>;
					const userKeys = oneTimeKeys[targetUserId as UserId] as Record<
						DeviceId,
						Record<string, string | JsonObject>
					>;
					userKeys[targetDeviceId as DeviceId] ??= {};
					(
						userKeys[targetDeviceId as DeviceId] as Record<
							string,
							string | JsonObject
						>
					)[claimed.keyId] = claimed.key as string | JsonObject;
				}
			}
		}

		return { status: 200, body: { one_time_keys: oneTimeKeys } };
	};

export const putSendToDevice =
	(storage: Storage): Handler =>
	async (req) => {
		const eventType = req.params.eventType as string;
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as {
			messages?: Record<UserId, Record<DeviceId, JsonObject>>;
		};

		if (!body.messages) throw badJson("Missing messages field");

		for (const [targetUserId, devices] of Object.entries(body.messages)) {
			for (const [targetDeviceId, content] of Object.entries(devices)) {
				if (targetDeviceId === "*") {
					const allDevices = await storage.getAllDevices(
						targetUserId as UserId,
					);
					for (const device of allDevices) {
						await storage.sendToDevice(
							targetUserId as UserId,
							device.device_id,
							{
								type: eventType,
								sender: userId,
								content,
							},
						);
					}
				} else {
					await storage.sendToDevice(
						targetUserId as UserId,
						targetDeviceId as DeviceId,
						{
							type: eventType,
							sender: userId,
							content,
						},
					);
				}
			}
		}

		return { status: 200, body: {} };
	};

export const getKeysChanges =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;

		// Get all rooms the requesting user is in
		const roomMemberships =
			await storage.getRoomsForUserWithMembership(userId);
		const joinedRoomIds = roomMemberships
			.filter((r) => r.membership === "join")
			.map((r) => r.roomId);

		// Collect all users in those rooms who have device keys
		const changedUsers = new Set<UserId>();
		for (const roomId of joinedRoomIds) {
			const members = await storage.getMemberEvents(roomId);
			for (const { event } of members) {
				const memberUserId = event.state_key as UserId | undefined;
				const membership = (
					event.content as { membership?: string } | undefined
				)?.membership;
				if (
					memberUserId &&
					membership === "join" &&
					memberUserId !== userId
				) {
					const keys = await storage.getAllDeviceKeys(memberUserId);
					if (Object.keys(keys).length > 0) {
						changedUsers.add(memberUserId);
					}
				}
			}
		}

		return {
			status: 200,
			body: {
				changed: [...changedUsers],
				left: [],
			},
		};
	};
