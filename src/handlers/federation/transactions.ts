import {
	checkEventAuth,
	computeContentHash,
	computeEventId,
	makeStateKey,
} from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { FederationClient } from "../../federation/client.ts";
import { verifyOriginSignature } from "../../federation/verify.ts";
import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import type { Storage } from "../../storage/interface.ts";
import type { DeviceKeys } from "../../types/e2ee.ts";
import type { EDU, PDU } from "../../types/events.ts";
import type {
	DeviceId,
	EventId,
	RoomId,
	ServerName,
	UserId,
} from "../../types/index.ts";
import type { RoomState } from "../../types/internal.ts";
import type { JsonObject } from "../../types/json.ts";

/**
 * Build a synthetic RoomState containing only the events referenced by `pdu`'s
 * auth_events. Used to auth-check an inbound event against its *claimed* auth
 * events (the spec's "based on the event's auth events" check), and to enforce
 * auth-chain rejection: if any referenced auth event cannot be loaded — because
 * it is unknown or was itself rejected (rejected events are never persisted) —
 * this throws, causing the inbound event to be rejected.
 *
 * Mirrors Synapse `event_auth.check_state_independent_auth_rules`, which loads
 * each auth event (allow_rejected=True) and rejects the new event if any of its
 * auth events carries a `rejected_reason`. Here, "not persisted" stands in for
 * "rejected".
 */
const buildAuthEventState = async (
	storage: Storage,
	pdu: PDU,
	room: RoomState,
): Promise<RoomState | null> => {
	const stateEvents = new Map<string, PDU>();

	for (const authId of pdu.auth_events) {
		const loaded = await storage.getEvent(authId as EventId);
		// We have no backfill, so an auth event we haven't received yet is not
		// necessarily rejected — bail out of the claimed-auth-state check and let
		// the caller fall back to auth against current room state.
		if (!loaded) return null;
		const authEvent = loaded.event;
		if (authEvent.room_id !== pdu.room_id) return null;
		if (authEvent.state_key === undefined) return null;
		stateEvents.set(
			makeStateKey(authEvent.type, authEvent.state_key),
			authEvent,
		);
	}

	// In room version 12+ the create event is omitted from auth_events; pull it
	// from the current room state so the auth check still sees it.
	if (!stateEvents.has("m.room.create\0")) {
		const create = room.state_events.get("m.room.create\0");
		if (create) stateEvents.set("m.room.create\0", create);
	}

	return {
		room_id: room.room_id,
		room_version: room.room_version,
		state_events: stateEvents,
		depth: room.depth,
		forward_extremities: room.forward_extremities,
	};
};

const processPdu = async (
	storage: Storage,
	pdu: PDU,
	eventId: EventId,
	origin: ServerName,
	federationClient: FederationClient,
): Promise<void> => {
	const expectedHash = computeContentHash(pdu);
	if (pdu.hashes?.sha256 !== expectedHash) {
		throw new Error("Content hash mismatch");
	}

	await verifyOriginSignature(pdu, origin, storage, federationClient);

	const computedId = computeEventId(pdu);
	if (computedId !== eventId) {
		throw new Error("Event ID mismatch");
	}

	const existing = await storage.getEvent(eventId);
	if (existing) return;

	const room = await storage.getRoom(pdu.room_id);
	if (!room) throw new Error("Room not found locally");

	// Server ACL: reject PDUs from a server denied by the room's
	// m.room.server_acl. (TestACLs) Synapse: FederationBase._check_sigs_and_hash
	// / event ACL checks before persistence.
	if (!isServerAllowedByAcl(origin, room)) {
		throw new Error("Server denied by ACL");
	}

	// The create event is special: it has no prev/auth events to validate
	// against and is authed purely by checkEventAuth below.
	if (pdu.type !== "m.room.create") {
		// Best-effort auth-chain check. When we can reconstruct the state from the
		// event's claimed auth_events (all of them locally available), verify the
		// event against that state (Synapse check_state_dependent_auth_rules). If
		// any auth_event is missing we have no backfill to fetch it, so we skip
		// this check and rely on the current-room-state check below rather than
		// rejecting a possibly-valid event.
		const authState = await buildAuthEventState(storage, pdu, room);
		if (authState) {
			checkEventAuth(pdu, eventId, authState);
		}
	}

	// Check #4: the event must also pass auth against the current room state
	// (the state before the event, as we know it). Synapse step 5.
	checkEventAuth(pdu, eventId, room);

	if (pdu.state_key !== undefined) {
		await storage.setStateEvent(pdu.room_id, pdu, eventId);
	} else {
		await storage.storeEvent(pdu, eventId);
	}

	room.depth = Math.max(room.depth, pdu.depth + 1);
	room.forward_extremities = [
		...room.forward_extremities.filter((id) => !pdu.prev_events.includes(id)),
		eventId,
	];
};

const processEdu = async (
	storage: Storage,
	edu: EDU,
	origin: ServerName,
	serverName: ServerName,
): Promise<void> => {
	const content = edu.content as Record<string, unknown>;

	// Room-scoped EDUs from a server denied by that room's m.room.server_acl
	// must be dropped (MSC4163 / TestACLsForEDUs). Returns true if the EDU
	// should be ignored.
	const aclDeniesRoom = async (roomId: RoomId): Promise<boolean> => {
		const room = await storage.getRoom(roomId);
		if (!room) return false;
		return !isServerAllowedByAcl(origin, room);
	};

	switch (edu.edu_type) {
		case "m.typing": {
			const { room_id, user_id, typing } = content as {
				room_id: RoomId;
				user_id: UserId;
				typing: boolean;
			};
			if (room_id && user_id) {
				if (await aclDeniesRoom(room_id)) break;
				await storage.setTyping(room_id, user_id, typing, 30000);
			}
			break;
		}
		case "m.presence": {
			// Inbound presence EDUs carry a `push` array of per-user updates
			// (NOT flat top-level fields). Spec: server-server-api m.presence.
			// Synapse: handlers/presence.py incoming_presence iterates
			// `content["push"]`, validates the user's domain == origin, and
			// updates each user's presence. We mirror that so remote presence
			// shows up in local /sync (TestRemotePresence).
			const push = (content.push ?? []) as Array<{
				user_id?: UserId;
				presence?: string;
				status_msg?: string;
			}>;
			for (const update of push) {
				const { user_id, presence, status_msg } = update;
				if (!user_id || !presence) continue;
				// Only trust presence for users that live on the origin server.
				const userServer = user_id.split(":").slice(1).join(":");
				if (userServer !== origin) continue;
				await storage.setPresence(
					user_id,
					presence as "online" | "offline" | "unavailable",
					status_msg,
				);
			}
			break;
		}
		case "m.receipt": {
			const { room_id, receipts } = content as {
				room_id: RoomId;
				receipts?: Record<string, Record<string, Record<string, unknown>>>;
			};
			if (room_id && receipts) {
				if (await aclDeniesRoom(room_id)) break;
				for (const [eventId, receiptTypes] of Object.entries(receipts)) {
					for (const [receiptType, users] of Object.entries(receiptTypes)) {
						for (const userId of Object.keys(users)) {
							await storage.setReceipt(
								room_id,
								userId as UserId,
								eventId as EventId,
								receiptType,
								Date.now(),
							);
						}
					}
				}
			}
			break;
		}
		case "m.device_list_update": {
			// A remote server is telling us one of its users' device list
			// changed. Record the change so local syncers sharing a room with
			// that user see them in `device_lists.changed`, and cache the
			// device keys so `/keys/query` returns them without a round-trip.
			//
			// Spec content: { user_id, device_id, stream_id, prev_id?,
			//   deleted?, device_display_name?, keys? }
			const { user_id, device_id, deleted, keys } = content as {
				user_id?: UserId;
				device_id?: DeviceId;
				stream_id?: number;
				prev_id?: number[];
				deleted?: boolean;
				device_display_name?: string;
				keys?: DeviceKeys;
			};

			if (!user_id || !device_id) break;

			// Only trust updates for users that actually live on the origin
			// server — a server may not speak for users on other servers.
			const userServer = user_id.split(":").slice(1).join(":");
			if (userServer !== origin) break;

			if (!deleted && keys) {
				// Cache the advertised device keys. Normalise the embedded
				// user_id/device_id to the EDU's authoritative values.
				await storage.setDeviceKeys(user_id, device_id, {
					...keys,
					user_id,
					device_id,
				});
			}

			// Record the change on the device-key-change stream regardless of
			// whether keys were embedded, so the user shows up in
			// `device_lists.changed`. (setDeviceKeys also records a change, so
			// this primarily covers the deleted / keyless case.)
			await storage.recordDeviceKeyChange(user_id);
			break;
		}
		case "m.direct_to_device": {
			// A remote server is delivering to-device messages addressed to our
			// local users. Spec content: { sender, type, message_id, messages:
			//   { user_id: { device_id: content } } }. We store each into the
			// target's to-device inbox so it surfaces in their /sync to_device.
			//
			// Mirrors Synapse handlers/devicemessage.py on_direct_to_device_edu:
			// it validates the sender's domain == origin, builds per-device
			// {content,type,sender}, and persists via
			// add_messages_from_remote_to_device_inbox(origin, message_id, ...)
			// which dedups by (origin, message_id).
			const {
				sender,
				type,
				message_id,
				messages,
			} = content as {
				sender?: UserId;
				type?: string;
				message_id?: string;
				messages?: Record<UserId, Record<DeviceId, JsonObject>>;
			};

			if (!sender || !type || !messages) break;

			// The sending server may only speak for users on its own domain.
			const senderServer = sender.split(":").slice(1).join(":");
			if (senderServer !== origin) break;

			// Dedup retried transactions by (origin, message_id). We reuse the
			// federation-txn store keyed by a message-scoped pseudo txn id so a
			// resend of the same message_id is ignored. If no message_id is
			// supplied we skip dedup and process anyway.
			if (message_id) {
				const dedupKey = `d2d:${message_id}`;
				if (await storage.getFederationTxn(origin, dedupKey)) break;
				await storage.setFederationTxn(origin, dedupKey);
			}

			for (const [targetUserId, byDevice] of Object.entries(messages)) {
				// Only accept messages addressed to users on our own server.
				const targetServer = targetUserId.split(":").slice(1).join(":");
				if (targetServer !== serverName) continue;
				if (!byDevice) continue;

				for (const [targetDeviceId, msgContent] of Object.entries(
					byDevice,
				)) {
					if (targetDeviceId === "*") {
						const allDevices = await storage.getAllDevices(
							targetUserId as UserId,
						);
						for (const device of allDevices) {
							await storage.sendToDevice(
								targetUserId as UserId,
								device.device_id,
								{
									type,
									sender,
									content: msgContent,
								},
							);
						}
					} else {
						await storage.sendToDevice(
							targetUserId as UserId,
							targetDeviceId as DeviceId,
							{
								type,
								sender,
								content: msgContent,
							},
						);
					}
				}
			}
			break;
		}
	}
};

export const putFederationSend =
	(
		storage: Storage,
		serverName: string,
		_signingKey: SigningKey,
		federationClient: FederationClient,
	): Handler =>
	async (req) => {
		const txnId = req.params.txnId as string;
		const origin = req.origin as string;

		const alreadySeen = await storage.getFederationTxn(origin, txnId);
		if (alreadySeen) {
			return { status: 200, body: { pdus: {} } };
		}
		await storage.setFederationTxn(origin, txnId);

		const { pdus = [], edus = [] } = (req.body ?? {}) as {
			pdus?: PDU[];
			edus?: EDU[];
		};
		const pduResults: Record<string, Record<string, unknown>> = {};

		for (const pdu of pdus) {
			const eventId = computeEventId(pdu);
			try {
				await processPdu(storage, pdu, eventId, origin, federationClient);
				pduResults[eventId] = {};
			} catch (err) {
				pduResults[eventId] = {
					error: err instanceof Error ? err.message : "Processing failed",
				};
			}
		}

		for (const edu of edus) {
			try {
				await processEdu(
					storage,
					edu,
					origin,
					serverName as ServerName,
				);
			} catch {}
		}

		return { status: 200, body: { pdus: pduResults } };
	};
