import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { SigningKey } from "../../signing.ts";
import type { RemoteKeyStore } from "../../federation/key-store.ts";
import type { FederationClient } from "../../federation/client.ts";
import type { PDU, EDU } from "../../types/events.ts";
import type {
	ServerName,
	EventId,
	KeyId,
	UserId,
	RoomId,
} from "../../types/index.ts";
import {
	computeEventId,
	computeContentHash,
	checkEventAuth,
} from "../../events.ts";
import { verifyEventSignature } from "../../signing.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";

// =============================================================================
// PUT /_matrix/federation/v1/send/:txnId
// =============================================================================

export function putFederationSend(
	storage: Storage,
	_serverName: string,
	_signingKey: SigningKey,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Handler {
	return async (req) => {
		const txnId = req.params["txnId"]!;
		const origin = req.origin!;

		// Transaction dedup
		const alreadySeen = await storage.getFederationTxn(origin, txnId);
		if (alreadySeen) {
			return { status: 200, body: { pdus: {} } };
		}
		await storage.setFederationTxn(origin, txnId);

		const body = (req.body ?? {}) as { pdus?: PDU[]; edus?: EDU[] };
		const pdus = body.pdus ?? [];
		const edus = body.edus ?? [];
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

		// Process EDUs
		for (const edu of edus) {
			try {
				await processEdu(storage, edu, origin);
			} catch {
				// EDU failures are silently ignored
			}
		}

		return { status: 200, body: { pdus: pduResults } };
	};
}

async function processPdu(
	storage: Storage,
	pdu: PDU,
	eventId: EventId,
	origin: ServerName,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Promise<void> {
	// 1. Verify content hash
	const expectedHash = computeContentHash(pdu);
	if (pdu.hashes?.sha256 !== expectedHash) {
		throw new Error("Content hash mismatch");
	}

	// 2. Verify signature from origin server
	const originSigs = pdu.signatures?.[origin];
	if (!originSigs) throw new Error(`No signature from origin ${origin}`);

	let sigValid = false;
	for (const keyId of Object.keys(originSigs)) {
		const pubKey = await remoteKeyStore.getServerKey(
			origin,
			keyId as KeyId,
			federationClient,
		);
		if (pubKey && verifyEventSignature(pdu, origin, keyId as KeyId, pubKey)) {
			sigValid = true;
			break;
		}
	}
	if (!sigValid) throw new Error("Invalid event signature");

	// 3. Verify event ID matches
	const computedId = computeEventId(pdu);
	if (computedId !== eventId) {
		throw new Error("Event ID mismatch");
	}

	// 4. Check if we already have this event
	const existing = await storage.getEvent(eventId);
	if (existing) return;

	// 5. Verify room exists locally
	const room = await storage.getRoom(pdu.room_id);
	if (!room) throw new Error("Room not found locally");

	// 6. Check ACL
	if (!isServerAllowedByAcl(origin, room)) {
		throw new Error("Server denied by ACL");
	}

	// 7. Auth check against local room state
	checkEventAuth(pdu, eventId, room);

	// 8. Store the event
	if (pdu.state_key !== undefined) {
		await storage.setStateEvent(pdu.room_id, pdu, eventId);
	} else {
		await storage.storeEvent(pdu, eventId);
	}

	// 9. Update room extremities
	room.depth = Math.max(room.depth, pdu.depth + 1);
	// Remove prev_events from extremities, add this event
	const newExtremities = room.forward_extremities.filter(
		(id) => !pdu.prev_events.includes(id),
	);
	newExtremities.push(eventId);
	room.forward_extremities = newExtremities;
}

async function processEdu(
	storage: Storage,
	edu: EDU,
	_origin: ServerName,
): Promise<void> {
	const content = edu.content as Record<string, unknown>;

	switch (edu.edu_type) {
		case "m.typing": {
			const roomId = content["room_id"] as RoomId;
			const userId = content["user_id"] as UserId;
			const typing = content["typing"] as boolean;
			if (roomId && userId) {
				await storage.setTyping(roomId, userId, typing, 30000);
			}
			break;
		}
		case "m.presence": {
			const userId = content["user_id"] as UserId;
			const presence = content["presence"] as string;
			if (userId && presence) {
				await storage.setPresence(
					userId,
					presence as "online" | "offline" | "unavailable",
					content["status_msg"] as string | undefined,
				);
			}
			break;
		}
		case "m.receipt": {
			const roomId = content["room_id"] as RoomId;
			const receipts = content["receipts"] as
				| Record<string, Record<string, Record<string, unknown>>>
				| undefined;
			if (roomId && receipts) {
				for (const [eventId, receiptTypes] of Object.entries(receipts)) {
					for (const [receiptType, users] of Object.entries(receiptTypes)) {
						for (const userId of Object.keys(users)) {
							await storage.setReceipt(
								roomId,
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
}
