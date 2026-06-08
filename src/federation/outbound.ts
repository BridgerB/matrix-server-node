import { randomBytes } from "node:crypto";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type { RoomId, ServerName } from "../types/index.ts";
import type { FederationClient } from "./client.ts";

/**
 * Outbound federation event dispatch ("the sender").
 *
 * When a local user creates an event (message, membership, state) in a room
 * that has remote members, that event must be pushed to every participating
 * remote server via PUT /_matrix/federation/v1/send/{txnId}. Without this,
 * remote members never observe locally-created events and federation
 * propagation is one-directional.
 *
 * This mirrors synapse's FederationSender / TransactionManager and dendrite's
 * federationapi queue, but in a deliberately minimal, best-effort form: we fan
 * the event out to all remote servers in the room in a single PDU transaction
 * each, fire-and-forget, and swallow per-destination failures. There is no
 * persistent queue, retry, or backoff — a destination that is offline simply
 * misses the event (acceptable for the in-memory homeserver; a real deployment
 * would need a durable queue as synapse/dendrite have).
 *
 * Preconditions:
 *  - `event` MUST already be signed by our server. Remote servers reject
 *    unsigned PDUs (signature verification in their inbound transaction path).
 */

/** Generate an opaque transaction ID for an outbound federation transaction. */
const newTxnId = (): string => randomBytes(16).toString("base64url");

/**
 * Send a single already-signed event to every remote server resident in the
 * room (excluding our own server). Per-destination delivery is fire-and-forget:
 * each PUT is launched without awaiting, and any error (network, signature, the
 * remote rejecting the PDU) is caught and logged but never propagated to the
 * caller. The function itself only awaits the (local) lookup of resident
 * servers.
 */
export const fanoutEvent = async (
	storage: Storage,
	serverName: string,
	_signingKey: SigningKey,
	federationClient: FederationClient,
	roomId: RoomId,
	event: PDU,
	eventId: string,
): Promise<void> => {
	let servers: ServerName[];
	try {
		servers = await storage.getServersInRoom(roomId);
	} catch (err) {
		console.error(
			`fanoutEvent: failed to resolve servers in room ${roomId}:`,
			(err as Error).message,
		);
		return;
	}

	const destinations = servers.filter((s) => s && s !== serverName);
	if (destinations.length === 0) return;

	for (const destination of destinations) {
		const txnId = newTxnId();
		const body = {
			origin: serverName,
			origin_server_ts: Date.now(),
			pdus: [event],
			edus: [],
		};

		// Fire-and-forget: do not await, and never let a per-destination failure
		// escape. A failed delivery just means that server misses this event.
		void federationClient
			.request(
				destination,
				"PUT",
				`/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`,
				body,
			)
			.then((resp) => {
				if (resp.status >= 400) {
					console.error(
						`fanoutEvent: ${destination} rejected ${eventId} (status ${resp.status})`,
					);
				}
			})
			.catch((err) => {
				console.error(
					`fanoutEvent: delivery of ${eventId} to ${destination} failed:`,
					(err as Error).message,
				);
			});
	}
};
