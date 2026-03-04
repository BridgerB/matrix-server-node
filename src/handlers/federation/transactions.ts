import {
	checkEventAuth,
	computeContentHash,
	computeEventId,
} from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { FederationClient } from "../../federation/client.ts";
import type { RemoteKeyStore } from "../../federation/key-store.ts";
import { verifyOriginSignature } from "../../federation/verify.ts";
import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import type { Storage } from "../../storage/interface.ts";
import type { EDU, PDU } from "../../types/events.ts";
import type { EventId, RoomId, ServerName, UserId } from "../../types/index.ts";

const processPdu = async (
	storage: Storage,
	pdu: PDU,
	eventId: EventId,
	origin: ServerName,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Promise<void> => {
	const expectedHash = computeContentHash(pdu);
	if (pdu.hashes?.sha256 !== expectedHash) {
		throw new Error("Content hash mismatch");
	}

	await verifyOriginSignature(pdu, origin, remoteKeyStore, federationClient);

	const computedId = computeEventId(pdu);
	if (computedId !== eventId) {
		throw new Error("Event ID mismatch");
	}

	const existing = await storage.getEvent(eventId);
	if (existing) return;

	const room = await storage.getRoom(pdu.room_id);
	if (!room) throw new Error("Room not found locally");

	if (!isServerAllowedByAcl(origin, room)) {
		throw new Error("Server denied by ACL");
	}

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
	_origin: ServerName,
): Promise<void> => {
	const content = edu.content as Record<string, unknown>;

	switch (edu.edu_type) {
		case "m.typing": {
			const { room_id, user_id, typing } = content as {
				room_id: RoomId;
				user_id: UserId;
				typing: boolean;
			};
			if (room_id && user_id)
				await storage.setTyping(room_id, user_id, typing, 30000);
			break;
		}
		case "m.presence": {
			const { user_id, presence, status_msg } = content as {
				user_id: UserId;
				presence: string;
				status_msg?: string;
			};
			if (user_id && presence) {
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
	}
};

export const putFederationSend =
	(
		storage: Storage,
		_serverName: string,
		_signingKey: SigningKey,
		remoteKeyStore: RemoteKeyStore,
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
				await processPdu(
					storage,
					pdu,
					eventId,
					origin,
					remoteKeyStore,
					federationClient,
				);
				pduResults[eventId] = {};
			} catch (err) {
				pduResults[eventId] = {
					error: err instanceof Error ? err.message : "Processing failed",
				};
			}
		}

		for (const edu of edus) {
			try {
				await processEdu(storage, edu, origin);
			} catch {}
		}

		return { status: 200, body: { pdus: pduResults } };
	};
