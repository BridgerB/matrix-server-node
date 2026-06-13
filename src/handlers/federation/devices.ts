import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { CrossSigningKey, DeviceKeys } from "../../types/e2ee.ts";
import type { DeviceId, KeyId, UserId } from "../../types/index.ts";
import { queryDeviceKeys, withDeviceDisplayName } from "../e2ee.ts";

/**
 * GET-style federation query for a single user's device list.
 *
 * Mirrors Synapse's `DeviceHandler.on_federation_query_user_devices`
 * (handlers/device.py), reached via `on_query_user_devices` in
 * federation_server.py. The response is a list of the user's devices, each with
 * its device keys and (optional) display name, plus the user's cross-signing
 * `master_key` / `self_signing_key` and a `stream_id`.
 */
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
			keys: DeviceKeys;
		}[] = [];

		for (const device of allDevices) {
			const keys = await storage.getDeviceKeys(
				userId,
				device.device_id as DeviceId,
			);
			if (keys) {
				const entry: {
					device_id: string;
					device_display_name?: string;
					keys: DeviceKeys;
				} = {
					device_id: device.device_id,
					keys,
				};
				if (device.display_name)
					entry.device_display_name = device.display_name;
				devices.push(entry);
			}
		}

		const crossKeys = await storage.getCrossSigningKeys(userId);

		const body: {
			user_id: UserId;
			stream_id: number;
			devices: typeof devices;
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
		} = {
			user_id: userId,
			stream_id: 0,
			devices,
		};
		if (crossKeys.master_key) body.master_key = crossKeys.master_key;
		if (crossKeys.self_signing_key)
			body.self_signing_key = crossKeys.self_signing_key;

		return { status: 200, body };
	};

/**
 * Federation device-key query: `POST /_matrix/federation/v1/user/keys/query`.
 *
 * A remote server asks us for the device keys of one or more of OUR local
 * users. Mirrors Synapse's `on_federation_query_client_keys`
 * (handlers/e2e_keys.py) which calls `query_local_devices(...,
 * include_displaynames=True)` and then merges in cross-signing keys.
 *
 * The important detail (asserted by Complement's
 * TestFederationKeyUploadQuery "Can query remote device keys using POST") is
 * that each returned device-keys object carries
 * `unsigned.device_display_name` set to the device's current display name, so
 * the requesting server can relay it to its client.
 */
export const postFederationKeysQuery =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			device_keys?: Record<UserId, DeviceId[]>;
		};

		const deviceKeys: Record<UserId, Record<DeviceId, DeviceKeys>> = {};
		const masterKeys: Record<UserId, CrossSigningKey> = {};
		const selfSigningKeys: Record<UserId, CrossSigningKey> = {};

		if (body.device_keys) {
			const result = await queryDeviceKeys(storage, body.device_keys);
			for (const userId of Object.keys(body.device_keys)) {
				const userKeys = result[userId as UserId] ?? {};

				// Enrich each device with its display name under
				// unsigned.device_display_name (Synapse: include_displaynames).
				const devices = await storage.getAllDevices(userId as UserId);
				const displayNames = new Map(
					devices
						.filter((d) => d.display_name)
						.map((d) => [d.device_id, d.display_name as string]),
				);

				const enriched: Record<DeviceId, DeviceKeys> = {};
				for (const [deviceId, keys] of Object.entries(userKeys)) {
					enriched[deviceId as DeviceId] = withDeviceDisplayName(
						keys,
						displayNames.get(deviceId),
					);
				}
				deviceKeys[userId as UserId] = enriched;

				// Cross-signing keys for the queried user, if present.
				const crossKeys = await storage.getCrossSigningKeys(
					userId as UserId,
				);
				if (crossKeys.master_key)
					masterKeys[userId as UserId] = crossKeys.master_key;
				if (crossKeys.self_signing_key)
					selfSigningKeys[userId as UserId] =
						crossKeys.self_signing_key;
			}
		}

		const responseBody: {
			device_keys: Record<UserId, Record<DeviceId, DeviceKeys>>;
			master_keys?: Record<UserId, CrossSigningKey>;
			self_signing_keys?: Record<UserId, CrossSigningKey>;
		} = { device_keys: deviceKeys };
		if (Object.keys(masterKeys).length > 0)
			responseBody.master_keys = masterKeys;
		if (Object.keys(selfSigningKeys).length > 0)
			responseBody.self_signing_keys = selfSigningKeys;

		return { status: 200, body: responseBody };
	};

/**
 * Federation one-time-key claim: `POST /_matrix/federation/v1/user/keys/claim`.
 *
 * A remote server claims one OTK for each requested (user, device, algorithm)
 * tuple from our local users. Mirrors Synapse's `on_claim_client_keys`
 * (federation_server.py) -> `claim_local_one_time_keys`.
 */
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
				for (const [deviceId, algorithm] of Object.entries(devices)) {
					const claimed = await storage.claimOneTimeKey(
						userId as UserId,
						deviceId as DeviceId,
						algorithm,
					);
					if (claimed) {
						const userKeys = (oneTimeKeys[userId as UserId] ??=
							{}) as Record<DeviceId, Record<KeyId, unknown>>;
						const deviceKeys = (userKeys[deviceId as DeviceId] ??=
							{}) as Record<KeyId, unknown>;
						deviceKeys[claimed.keyId] = claimed.key;
					}
				}
			}
		}

		return {
			status: 200,
			body: { one_time_keys: oneTimeKeys },
		};
	};
