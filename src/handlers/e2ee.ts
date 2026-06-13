import { generateToken } from "../crypto.ts";
import { domainOf } from "../ids.ts";
import { badJson } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import { deliverEduToDestination } from "../federation/outbound.ts";
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
import type { EDU } from "../types/events.ts";
import type { DeviceId, RoomId, ServerName, UserId } from "../types/index.ts";
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
export const sendDeviceListUpdate = async (
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
			const memberServer = domainOf(memberId);
			if (memberServer && memberServer !== serverName) {
				destinations.add(memberServer as ServerName);
			}
		}
		// MSC3706: a partial-state room's member events are mostly omitted, so the
		// loop above misses its servers; include the recorded servers_in_room so
		// device-list updates still reach everyone in the room during the resync.
		const ps = await storage.getRoomPartialState(roomId);
		if (ps) {
			for (const s of ps.servers) {
				if (s !== serverName) destinations.add(s);
			}
			// We only know SOME of this room's servers right now. Record the change
			// so that when the resync reveals the rest, we re-send it to them
			// (synapse device_lists_outbound_pokes).
			await storage.recordPartialStateDevicePoke(roomId, userId, deviceId);
		}
	}

	await deliverDeviceListUpdateTo(
		storage,
		serverName,
		federationClient,
		userId,
		deviceId,
		destinations,
	);
};

/** Build and deliver an m.device_list_update for `userId`/`deviceId` to a
 * specific set of destination servers. Shared by the normal send path and the
 * partial-state resync re-send. */
const deliverDeviceListUpdateTo = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient,
	userId: UserId,
	deviceId: DeviceId,
	destinations: Set<ServerName>,
): Promise<void> => {
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
	// Per the spec, the EDU should carry the device's human-readable name so a
	// display-name change propagates to remote servers (see
	// TestDeviceListsUpdateOverFederation's spec quote: "...changes in device
	// information such as the device's human-readable name"). Mirrors Synapse's
	// DeviceHandler, which includes `device_display_name` in the federated update.
	const device = await storage.getDevice(userId, deviceId);
	if (device?.display_name) content.device_display_name = device.display_name;

	const edu: EDU = {
		edu_type: "m.device_list_update",
		content: content as EDU["content"],
	};

	// Durable per-destination delivery: an unreachable peer has the EDU queued
	// and replayed on recovery (TestDeviceListsUpdateOverFederation's
	// "interrupted/stopped server" cases). Errors are isolated per destination
	// inside deliverEduToDestination, so the upload response is never affected.
	for (const dest of destinations) {
		await deliverEduToDestination(
			storage,
			serverName,
			federationClient,
			dest,
			edu,
		);
	}
};

/**
 * Once a partial-state room's resync completes, re-send any local device-list
 * changes made during the partial join to servers that were in the room at our
 * join but were NOT named in the resident's servers_in_room — we never told
 * them. Mirrors synapse's handle_room_un_partial_stated outbound-poke step.
 */
export const resyncOutgoingDeviceListPokes = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient,
	roomId: RoomId,
	serversAtJoin: Set<ServerName>,
	toldServers: Set<ServerName>,
): Promise<void> => {
	const newlyDiscovered = new Set<ServerName>();
	for (const s of serversAtJoin) {
		if (s && s !== serverName && !toldServers.has(s)) newlyDiscovered.add(s);
	}
	const pokes = await storage.takePartialStateDevicePokes(roomId);
	if (newlyDiscovered.size === 0) return;
	for (const { userId, deviceId } of pokes) {
		await deliverDeviceListUpdateTo(
			storage,
			serverName,
			federationClient,
			userId,
			deviceId,
			newlyDiscovered,
		);
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

/** Extract the server-name portion of a Matrix user ID (`@local:server`). */
/**
 * Return a copy of `keys` with `device_display_name` folded into `unsigned`,
 * matching what /keys/query returns (synapse's include_displaynames). The input
 * is not mutated; when there is no display name the original object is returned.
 */
export const withDeviceDisplayName = (
	keys: DeviceKeys,
	displayName: string | undefined,
): DeviceKeys => {
	if (!displayName) return keys;
	const { unsigned } = keys as DeviceKeys & {
		unsigned?: Record<string, unknown>;
	};
	return {
		...keys,
		unsigned: { ...unsigned, device_display_name: displayName },
	} as DeviceKeys;
};

// A remote user's device list is "tracked" — and therefore safe to cache and
// serve without a fresh federation round-trip — once they share a fully-resolved
// (non-partial-state) room with us. While the only shared room is still
// partial-state we are not yet certain of the membership, so every /keys/query
// must federate (TestPartialStateJoin Device_list_tracking).
const isRemoteUserTracked = async (
	storage: Storage,
	userId: UserId,
	serverName?: ServerName,
): Promise<boolean> => {
	const rooms = await storage.getRoomsForUser(userId);
	for (const roomId of rooms) {
		// A fully-resolved room → we are certain of its membership. But we only
		// track (and cache keys for) the remote user while they still share that
		// room with a LOCAL user; once our last local user leaves, we stop
		// receiving their device-list updates, so any cache would go stale
		// (TestDeviceListUpdates when_leaving_a_room_with_a_remote_user). When we
		// have no serverName we cannot tell local from remote — fall back to the
		// looser "any non-partial shared room" rule.
		if (!(await storage.getRoomPartialState(roomId))) {
			if (!serverName) return true;
			const members = await storage.getMemberEvents(roomId);
			for (const m of members) {
				const sk = m.event.state_key;
				if (!sk) continue;
				if (
					(m.event.content as { membership?: string }).membership !==
					"join"
				)
					continue;
				if (domainOf(sk) === serverName) return true;
			}
			continue;
		}
		// A partial-state room where we nonetheless WITNESSED this user join live
		// (their join is in the forward timeline, not a resync-filled historical
		// entry) → we are certain they are here. This is how a member who joins
		// during the resync is tracked while the omitted pre-existing members are
		// not yet.
		const tl = await storage.getEventsByRoomSince(roomId, 0, 100000);
		for (const { event } of tl.events) {
			if (
				event.type === "m.room.member" &&
				event.state_key === userId &&
				(event.content as { membership?: string }).membership === "join"
			) {
				return true;
			}
		}
	}
	return false;
};

export { isRemoteUserTracked };

export const postKeysQuery =
	(
		storage: Storage,
		serverName?: ServerName,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as KeysQueryRequest;
		if (!body.device_keys) throw badJson("Missing device_keys field");

		// Split the requested users by homeserver. Users on our own server (or
		// any server when federation isn't wired) go through the local path;
		// users on other servers are federated. Mirrors Synapse's
		// E2eKeysHandler.query_devices, which partitions into local_query and
		// remote_queries and fans out one federation request per destination.
		const localRequest: Record<string, string[]> = {};
		const remoteByDest = new Map<ServerName, Record<string, string[]>>();
		// Tracked remote users whose keys we don't yet hold: we fetch their full
		// device list via GET /user/devices/{userId} (a "device-list resync") and
		// cache it, rather than an on-demand /user/keys/query. This mirrors synapse,
		// which tracks a user's devices through /user/devices and serves later
		// /keys/query from the cache (TestPartialStateJoin Device_list_tracking).
		const trackedUncached: UserId[] = [];
		for (const [targetUserId, deviceIds] of Object.entries(
			body.device_keys,
		)) {
			const dest = domainOf(targetUserId) as ServerName;
			if (!serverName || !federationClient || dest === serverName) {
				localRequest[targetUserId] = deviceIds;
			} else if (
				await isRemoteUserTracked(storage, targetUserId as UserId, serverName)
			) {
				if (
					Object.keys(await storage.getAllDeviceKeys(targetUserId as UserId))
						.length > 0
				) {
					// Tracked and already cached → serve from our cache, no federation
					// round-trip.
					localRequest[targetUserId] = deviceIds;
				} else {
					// Tracked but not yet cached → resync via /user/devices.
					trackedUncached.push(targetUserId as UserId);
				}
			} else {
				// Not tracked (no shared room) → on-demand /user/keys/query, no cache.
				const group = remoteByDest.get(dest) ?? {};
				group[targetUserId] = deviceIds;
				remoteByDest.set(dest, group);
			}
		}

		const deviceKeys = await queryDeviceKeys(storage, localRequest);

		const masterKeys: Record<UserId, CrossSigningKey> = {};
		const selfSigningKeys: Record<UserId, CrossSigningKey> = {};
		const userSigningKeys: Record<UserId, CrossSigningKey> = {};

		for (const targetUserId of Object.keys(localRequest)) {
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

		// Federate remote users: one request per destination server, merging
		// device_keys/master_keys/self_signing_keys into the combined result.
		// Per-destination errors are swallowed into `failures` (Synapse:
		// _query_devices_for_destination records failures and continues).
		const failures: Record<string, unknown> = {};
		if (federationClient) {
			// Resync tracked-but-uncached users' device lists via /user/devices.
			for (const u of trackedUncached) {
				const dest = domainOf(u) as ServerName;
				try {
					const { body: respBody } = await federationClient.request(
						dest,
						"GET",
						`/_matrix/federation/v1/user/devices/${encodeURIComponent(u)}`,
					);
					const resp = (respBody ?? {}) as {
						devices?: {
							device_id: DeviceId;
							device_display_name?: string;
							keys: DeviceKeys;
						}[];
						master_key?: CrossSigningKey;
						self_signing_key?: CrossSigningKey;
					};
					const userDevices: Record<DeviceId, DeviceKeys> = {};
					for (const d of resp.devices ?? []) {
						if (!d.keys) continue;
						const keys = withDeviceDisplayName(d.keys, d.device_display_name);
						userDevices[d.device_id] = keys;
						await storage.setDeviceKeys(u, d.device_id, keys);
					}
					deviceKeys[u] = userDevices;
					if (resp.master_key) masterKeys[u] = resp.master_key;
					if (resp.self_signing_key) selfSigningKeys[u] = resp.self_signing_key;
				} catch (err) {
					failures[dest] = {
						message: err instanceof Error ? err.message : String(err),
					};
				}
			}

			for (const [dest, group] of remoteByDest) {
				try {
					const { body: respBody } = await federationClient.request(
						dest,
						"POST",
						"/_matrix/federation/v1/user/keys/query",
						{ device_keys: group },
					);
					const resp = (respBody ?? {}) as {
						device_keys?: Record<
							UserId,
							Record<DeviceId, DeviceKeys>
						>;
						master_keys?: Record<UserId, CrossSigningKey>;
						self_signing_keys?: Record<UserId, CrossSigningKey>;
					};
					if (resp.device_keys) {
						for (const [u, keys] of Object.entries(
							resp.device_keys,
						)) {
							deviceKeys[u as UserId] = keys;
							// Cache for subsequent queries once we are tracking the
							// user (they share a non-partial room with us), so the next
							// /keys/query is served locally without federating.
							if (
							await isRemoteUserTracked(
								storage,
								u as UserId,
								serverName,
							)
						) {
								for (const [did, k] of Object.entries(keys)) {
									await storage.setDeviceKeys(
										u as UserId,
										did as DeviceId,
										k,
									);
								}
							}
						}
					}
					if (resp.master_keys) {
						for (const [u, k] of Object.entries(resp.master_keys)) {
							masterKeys[u as UserId] = k;
						}
					}
					if (resp.self_signing_keys) {
						for (const [u, k] of Object.entries(
							resp.self_signing_keys,
						)) {
							selfSigningKeys[u as UserId] = k;
						}
					}
				} catch (err) {
					failures[dest] = {
						message: err instanceof Error ? err.message : String(err),
					};
				}
			}
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
				failures:
					Object.keys(failures).length > 0 ? failures : undefined,
			},
		};
	};

export const postKeysClaim =
	(
		storage: Storage,
		serverName?: ServerName,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as KeysClaimRequest;
		if (!body.one_time_keys) throw badJson("Missing one_time_keys field");

		const oneTimeKeys: Record<
			UserId,
			Record<DeviceId, Record<string, string | JsonObject>>
		> = {};

		// Split (user, device, algorithm) tuples by homeserver. Mirrors
		// Synapse's E2eKeysHandler.claim_client_keys, which separates local
		// claims from remote ones and issues one federation request per dest.
		const localClaims: Record<string, Record<string, string>> = {};
		const remoteByDest = new Map<
			ServerName,
			Record<string, Record<string, string>>
		>();
		for (const [targetUserId, devices] of Object.entries(
			body.one_time_keys,
		)) {
			const dest = domainOf(targetUserId) as ServerName;
			const isLocal =
				!serverName || !federationClient || dest === serverName;
			for (const [targetDeviceId, algorithm] of Object.entries(devices)) {
				if (isLocal) {
					(localClaims[targetUserId] ??= {})[targetDeviceId] =
						algorithm;
				} else {
					const group = remoteByDest.get(dest) ?? {};
					(group[targetUserId] ??= {})[targetDeviceId] = algorithm;
					remoteByDest.set(dest, group);
				}
			}
		}

		for (const [targetUserId, devices] of Object.entries(localClaims)) {
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

		// Federate remote claims: one request per destination, merging the
		// returned one_time_keys. Per-destination errors are swallowed so a
		// failing peer doesn't fail the whole claim.
		const failures: Record<string, unknown> = {};
		if (federationClient) {
			for (const [dest, group] of remoteByDest) {
				try {
					const { body: respBody } = await federationClient.request(
						dest,
						"POST",
						"/_matrix/federation/v1/user/keys/claim",
						{ one_time_keys: group },
					);
					const resp = (respBody ?? {}) as {
						one_time_keys?: Record<
							UserId,
							Record<
								DeviceId,
								Record<string, string | JsonObject>
							>
						>;
					};
					if (resp.one_time_keys) {
						for (const [u, devs] of Object.entries(
							resp.one_time_keys,
						)) {
							const existing = (oneTimeKeys[u as UserId] ??=
								{}) as Record<
								DeviceId,
								Record<string, string | JsonObject>
							>;
							for (const [d, keys] of Object.entries(devs)) {
								existing[d as DeviceId] = keys;
							}
						}
					}
				} catch (err) {
					failures[dest] = {
						message: err instanceof Error ? err.message : String(err),
					};
				}
			}
		}

		return {
			status: 200,
			body: {
				one_time_keys: oneTimeKeys,
				failures:
					Object.keys(failures).length > 0 ? failures : undefined,
			},
		};
	};

export const putSendToDevice =
	(
		storage: Storage,
		serverName?: ServerName,
		_signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const eventType = req.params.eventType as string;
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as {
			messages?: Record<UserId, Record<DeviceId, JsonObject>>;
		};

		if (!body.messages) throw badJson("Missing messages field");

		// Partition targets into local (delivered straight to storage so they
		// surface in the user's /sync to_device) and remote (delivered to the
		// owning homeserver via an `m.direct_to_device` federation EDU). Mirrors
		// Synapse's DeviceMessageHandler.send_device_message, which splits
		// messages into `local_messages` and `remote_messages` keyed by
		// destination and queues one EDU per destination.
		const remoteByDest = new Map<
			ServerName,
			Record<UserId, Record<DeviceId, JsonObject>>
		>();

		for (const [targetUserId, devices] of Object.entries(body.messages)) {
			const dest = domainOf(targetUserId) as ServerName;
			const isLocal =
				!serverName || !federationClient || dest === serverName;

			if (!isLocal) {
				// Forward verbatim to the owning server. The "*" wildcard device
				// is left intact for the destination to expand against its own
				// device list (it knows the target's devices; we don't).
				const group = remoteByDest.get(dest) ?? {};
				group[targetUserId as UserId] = devices;
				remoteByDest.set(dest, group);
				continue;
			}

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

		// Deliver one `m.direct_to_device` EDU per remote destination. Each
		// carries a unique message_id (Synapse: random_string(16)) so the
		// receiver can dedup retried transactions. Fire-and-forget: a failing or
		// unreachable peer must not fail the client's sendToDevice request (the
		// Complement "interrupted/stopped server" cases rely on the 200 even
		// while the peer is down — they assert eventual delivery via /sync, which
		// in this in-memory server is satisfied by the receiver acting on the
		// EDU once it is reachable again).
		if (serverName && federationClient && remoteByDest.size > 0) {
			for (const [dest, messages] of remoteByDest) {
				const edu: EDU = {
					edu_type: "m.direct_to_device",
					content: {
						sender: userId,
						type: eventType,
						message_id: generateToken(),
						messages,
					} as EDU["content"],
				};
				// Durable delivery: if `dest` is unreachable the EDU is persisted
				// and replayed on recovery (TestToDeviceMessagesOverFederation's
				// "interrupted/stopped server" cases). Errors are isolated inside
				// deliverEduToDestination, so the client's sendToDevice still 200s
				// even while the peer is down. NOT awaited in the request path —
				// blocking /sendToDevice on a slow/unreachable federation round-trip
				// adds latency to every E2EE send and causes timeouts under load.
				void deliverEduToDestination(
					storage,
					serverName,
					federationClient,
					dest,
					edu,
				).catch(() => {});
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

		// `changed`: users with a device-list change in the window who STILL share
		// a joined room with us (their keys are worth re-fetching).
		// `left`: users with a change in the window who NO LONGER share any joined
		// room with us — the client should drop their cached device list. Mirrors
		// Synapse's DeviceHandler.get_user_ids_changed, which partitions the
		// changed set into `changed` and `left` by current room-sharing. (The
		// requester is never reported in `left`.)
		const changed: UserId[] = [];
		const left: UserId[] = [];
		const changedSet = new Set<UserId>();
		for (const u of changedInWindow) {
			if (sharedUsers.has(u)) changedSet.add(u);
			else if (u !== userId) left.push(u);
		}

		// Also report users who newly JOINED a shared room within (from, to] even
		// without a device-key change: we now share a room with them and the
		// client must fetch their device list. Mirrors sync's device_lists.changed
		// step 1b, and is how a member revealed during a partial-state join (or one
		// who simply joins while we are syncing) surfaces here.
		for (const roomId of joinedRoomIds) {
			const windowEvents = await storage.getEventsByRoomSince(
				roomId,
				from,
				100000,
			);
			for (const { event, streamPos } of windowEvents.events) {
				if (streamPos > to) continue;
				const sk = event.state_key as UserId | undefined;
				if (
					event.type === "m.room.member" &&
					(event.content as { membership?: string }).membership === "join" &&
					sk &&
					sk !== userId
				) {
					changedSet.add(sk);
				}
			}
		}
		for (const u of changedSet) changed.push(u);

		return {
			status: 200,
			body: {
				changed,
				left,
			},
		};
	};
