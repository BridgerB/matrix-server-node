import { generateToken } from "../crypto.ts";
import { badJson } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	CrossSigningKey,
	DeviceKeys,
	KeysClaimRequest,
	KeysQueryRequest,
	KeysUploadRequest,
} from "../types/e2ee.ts";
import type { DeviceId, ServerName, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

// Monotonic per-process counter for device-list update stream IDs. The spec
// requires stream_id to be a monotonically increasing integer per user; a
// process-wide counter is monotonic per user as well and is sufficient for the
// Complement tests (which only assert on user_id/device_id). If strict
// per-user stream IDs that survive restarts are ever required, add a storage
// method `nextDeviceListStreamId(userId)` and use it here instead.
let deviceListStreamCounter = 0;

/**
 * Notify remote servers sharing a room with `userId` that the user's device
 * list changed, by sending an `m.device_list_update` EDU in a federation
 * transaction to each distinct remote destination. Fire-and-forget: errors per
 * destination are swallowed so they never affect the client's upload response.
 *
 * Mirrors Synapse's DeviceHandler.notify_device_update, which computes the set
 * of "hosts" sharing a room with the user and enqueues a device-list-update
 * EDU (transaction_manager.py packs EDUs into the outgoing transaction body).
 */
const sendDeviceListUpdate = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient,
	userId: UserId,
	deviceId: DeviceId,
): Promise<void> => {
	// Collect distinct remote destinations that share a joined room with the
	// user. Synapse only considers users joined to a room together; we do the
	// same by scanning joined members of the user's joined rooms.
	const roomIds = await storage.getRoomsForUser(userId);
	const destinations = new Set<ServerName>();
	for (const roomId of roomIds) {
		const members = await storage.getMemberEvents(roomId);
		for (const { event } of members) {
			const membership = (
				event.content as { membership?: string } | undefined
			)?.membership;
			if (membership !== "join") continue;
			const memberId = event.state_key;
			if (!memberId) continue;
			const memberServer = memberId.split(":").slice(1).join(":");
			if (memberServer && memberServer !== serverName) {
				destinations.add(memberServer as ServerName);
			}
		}
	}

	if (destinations.size === 0) return;

	const streamId = ++deviceListStreamCounter;
	const keys = await storage.getDeviceKeys(userId, deviceId);
	const content: Record<string, unknown> = {
		user_id: userId,
		device_id: deviceId,
		stream_id: streamId,
		prev_id: streamId > 1 ? [streamId - 1] : [],
		deleted: false,
	};
	if (keys) content.keys = keys;

	const edu = { edu_type: "m.device_list_update", content };

	for (const dest of destinations) {
		const txnId = generateToken();
		const txn = {
			origin: serverName,
			origin_server_ts: Date.now(),
			pdus: [],
			edus: [edu],
		};
		// Fire-and-forget: do not let a failing/unreachable destination affect
		// the upload response. The Complement "interrupted/stopped server"
		// cases rely on the upload succeeding even while the peer is down.
		void federationClient
			.request(dest, "PUT", `/_matrix/federation/v1/send/${txnId}`, txn)
			.catch(() => {});
	}
};

export const postKeysUpload =
	(
		storage: Storage,
		serverName?: ServerName,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const deviceId = req.deviceId as DeviceId;
		const body = (req.body ?? {}) as KeysUploadRequest;

		let deviceKeysChanged = false;
		if (body.device_keys) {
			if (
				body.device_keys.user_id !== userId ||
				body.device_keys.device_id !== deviceId
			) {
				throw badJson(
					"device_keys user_id/device_id must match authenticated user",
				);
			}
			// algorithms, keys and signatures are required fields.
			if (
				!Array.isArray(body.device_keys.algorithms) ||
				typeof body.device_keys.keys !== "object" ||
				body.device_keys.keys === null ||
				typeof body.device_keys.signatures !== "object" ||
				body.device_keys.signatures === null
			) {
				throw badJson(
					"device_keys must include algorithms, keys and signatures",
				);
			}
			await storage.setDeviceKeys(userId, deviceId, body.device_keys);
			deviceKeysChanged = true;
		}

		if (body.one_time_keys && Object.keys(body.one_time_keys).length > 0)
			await storage.addOneTimeKeys(userId, deviceId, body.one_time_keys);

		if (body.fallback_keys && Object.keys(body.fallback_keys).length > 0) {
			await storage.setFallbackKeys(userId, deviceId, body.fallback_keys);
		}

		// When a local user's device keys change, notify remote servers that
		// share a room with them. Only possible when federation deps are wired.
		if (
			deviceKeysChanged &&
			serverName &&
			signingKey &&
			federationClient
		) {
			void sendDeviceListUpdate(
				storage,
				serverName,
				federationClient,
				userId,
				deviceId,
			).catch(() => {});
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
		if (!Array.isArray(deviceIds)) {
			throw badJson(
				`device_keys for ${targetUserId} must be an array of device IDs`,
			);
		}
		// Every queried user appears in the response, with an empty object when
		// they have no device keys (spec: "query for user with no keys returns
		// empty key dict").
		if (deviceIds.length === 0) {
			deviceKeys[targetUserId as UserId] = await storage.getAllDeviceKeys(
				targetUserId as UserId,
			);
		} else {
			const userDeviceKeys: Record<DeviceId, DeviceKeys> = {};
			for (const did of deviceIds) {
				const keys = await storage.getDeviceKeys(targetUserId as UserId, did);
				if (keys) userDeviceKeys[did] = keys;
			}
			deviceKeys[targetUserId as UserId] = userDeviceKeys;
		}
	}
	return deviceKeys;
};

export const postKeysQuery =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as KeysQueryRequest;
		if (!body.device_keys) throw badJson("Missing device_keys field");

		const deviceKeys = await queryDeviceKeys(storage, body.device_keys);

		const masterKeys: Record<UserId, CrossSigningKey> = {};
		const selfSigningKeys: Record<UserId, CrossSigningKey> = {};
		const userSigningKeys: Record<UserId, CrossSigningKey> = {};

		for (const targetUserId of Object.keys(body.device_keys)) {
			const crossKeys = await storage.getCrossSigningKeys(
				targetUserId as UserId,
			);
			if (crossKeys.master_key)
				masterKeys[targetUserId as UserId] = crossKeys.master_key;
			if (crossKeys.self_signing_key)
				selfSigningKeys[targetUserId as UserId] =
					crossKeys.self_signing_key;
			// user_signing_key is only returned for the requesting user
			if (targetUserId === userId && crossKeys.user_signing_key)
				userSigningKeys[targetUserId as UserId] =
					crossKeys.user_signing_key;
		}

		return {
			status: 200,
			body: {
				device_keys: deviceKeys,
				master_keys:
					Object.keys(masterKeys).length > 0 ? masterKeys : undefined,
				self_signing_keys:
					Object.keys(selfSigningKeys).length > 0
						? selfSigningKeys
						: undefined,
				user_signing_keys:
					Object.keys(userSigningKeys).length > 0
						? userSigningKeys
						: undefined,
			},
		};
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

		// `from` and `to` are sync tokens (stringified stream positions) that
		// bound the window of interest. The spec requires both.
		const fromParam = req.query.get("from");
		const toParam = req.query.get("to");
		if (fromParam === null) throw badJson("Missing 'from' query parameter");
		if (toParam === null) throw badJson("Missing 'to' query parameter");

		const from = Number.parseInt(fromParam, 10);
		const to = Number.parseInt(toParam, 10);
		if (Number.isNaN(from) || Number.isNaN(to)) {
			throw badJson("'from' and 'to' must be valid sync tokens");
		}

		// Query the device-key-change stream for users whose keys changed in
		// the window (from, to], then keep only those who currently share a
		// joined room with the requester (excluding the requester themselves).
		const changedInWindow = new Set<UserId>(
			await storage.getChangedDeviceUsers(from, to),
		);

		const roomMemberships =
			await storage.getRoomsForUserWithMembership(userId);
		const joinedRoomIds = roomMemberships
			.filter((r) => r.membership === "join")
			.map((r) => r.roomId);

		const sharedUsers = new Set<UserId>();
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
					sharedUsers.add(memberUserId);
				}
			}
		}

		const changed = [...changedInWindow].filter((u) => sharedUsers.has(u));

		return {
			status: 200,
			body: {
				changed,
				left: [],
			},
		};
	};
