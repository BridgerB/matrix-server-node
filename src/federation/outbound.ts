import { randomBytes } from "node:crypto";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { EDU, PDU } from "../types/events.ts";
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
 * Max EDUs packed into a single replay transaction. Federation transactions are
 * capped at 100 EDUs by the spec; we stay well under that. Synapse uses the same
 * 100-EDU-per-transaction limit in TransactionManager.
 */
const MAX_EDUS_PER_TXN = 100;

/** PUT a freshly-stamped `/send` transaction carrying the given PDUs/EDUs. */
const sendTransaction = (
	federationClient: FederationClient,
	serverName: string,
	destination: ServerName,
	contents: { pdus?: PDU[]; edus?: EDU[] },
): Promise<{ status: number; body: unknown }> =>
	federationClient.request(
		destination,
		"PUT",
		`/_matrix/federation/v1/send/${encodeURIComponent(newTxnId())}`,
		{
			origin: serverName,
			origin_server_ts: Date.now(),
			pdus: contents.pdus ?? [],
			edus: contents.edus ?? [],
		},
	);

/**
 * Fire-and-forget one transaction to a destination: launched without awaiting,
 * never letting a per-destination failure escape. `describe` prefixes the log
 * line on a rejection (non-2xx) or transport error. A failed delivery just means
 * that server misses this event/EDU.
 */
const deliverFireAndForget = (
	federationClient: FederationClient,
	serverName: string,
	destination: ServerName,
	contents: { pdus?: PDU[]; edus?: EDU[] },
	describe: string,
): void => {
	void sendTransaction(federationClient, serverName, destination, contents)
		.then((resp) => {
			if (resp.status >= 400) {
				console.error(
					`${describe} to ${destination} rejected (status ${resp.status})`,
				);
			}
		})
		.catch((err) => {
			console.error(
				`${describe} to ${destination} failed:`,
				(err as Error).message,
			);
		});
};

/**
 * Deliver an EDU to a single destination with a durable retry queue, mirroring
 * Synapse's PerDestinationQueue:
 *
 *  1. Drain any EDUs previously queued for this destination (catch-up) and batch
 *     them with the new EDU into one federation transaction.
 *  2. POST the transaction. On success (2xx) delete the delivered queued entries
 *     so they are not re-sent.
 *  3. On failure (network error / non-2xx) persist the NEW edu to the queue for
 *     this destination so it is replayed the next time we successfully contact
 *     it (next outbound send, or the periodic/startup catch-up sweep). Already
 *     queued entries are left in place to retry again later.
 *
 * The new EDU is always persisted up-front when there is a backlog, so a crash
 * mid-flight never loses it; on success the whole batch is deleted.
 */
export const deliverEduToDestination = async (
	storage: Storage,
	serverName: string,
	federationClient: FederationClient,
	destination: ServerName,
	edu: EDU,
): Promise<void> => {
	// Pull any backlog for this destination first.
	let pending: { id: number; edu: EDU }[];
	try {
		pending = await storage.getPendingFederationEdus(
			destination,
			MAX_EDUS_PER_TXN - 1,
		);
	} catch (err) {
		console.error(
			`deliverEdu: failed to load pending EDUs for ${destination}:`,
			(err as Error).message,
		);
		pending = [];
	}

	// Persist the new EDU now (so it survives a crash) only when there is a
	// backlog — otherwise we optimistically try the fast path and queue on
	// failure, avoiding a write on the common (peer-up) case.
	let newEntryId: number | undefined;
	if (pending.length > 0) {
		try {
			newEntryId = await storage.enqueueFederationEdu(destination, edu);
		} catch (err) {
			console.error(
				`deliverEdu: failed to enqueue EDU for ${destination}:`,
				(err as Error).message,
			);
		}
	}

	const batch: { id?: number; edu: EDU }[] = [
		...pending,
		newEntryId !== undefined ? { id: newEntryId, edu } : { edu },
	];

	let delivered = false;
	try {
		const resp = await sendTransaction(
			federationClient,
			serverName,
			destination,
			{
				edus: batch.map((b) => b.edu),
			},
		);
		delivered = resp.status < 400;
		if (!delivered) {
			console.error(
				`deliverEdu: ${destination} rejected EDU batch (status ${resp.status})`,
			);
		}
	} catch (err) {
		console.error(
			`deliverEdu: delivery to ${destination} failed:`,
			(err as Error).message,
		);
	}

	if (delivered) {
		// Remove every successfully delivered persisted entry.
		for (const b of batch) {
			if (b.id !== undefined) {
				await storage.deleteFederationEdu(b.id).catch(() => {});
			}
		}
		return;
	}

	// Delivery failed. Ensure the new EDU is persisted for a later replay (it is
	// already persisted when there was a backlog; queue it now otherwise).
	if (newEntryId === undefined) {
		await storage
			.enqueueFederationEdu(destination, edu)
			.catch((err: Error) =>
				console.error(
					`deliverEdu: failed to enqueue EDU for ${destination} after delivery failure:`,
					err.message,
				),
			);
	}
};

/**
 * Replay queued EDUs for a single destination (catch-up). Sends batches until
 * the queue is empty or a send fails (in which case we stop and leave the rest
 * for the next sweep). Used by the startup/periodic catch-up sweep.
 */
export const flushPendingEdusForDestination = async (
	storage: Storage,
	serverName: string,
	federationClient: FederationClient,
	destination: ServerName,
): Promise<void> => {
	for (;;) {
		let pending: { id: number; edu: EDU }[];
		try {
			pending = await storage.getPendingFederationEdus(
				destination,
				MAX_EDUS_PER_TXN,
			);
		} catch {
			return;
		}
		if (pending.length === 0) return;

		let delivered = false;
		try {
			const resp = await sendTransaction(
				federationClient,
				serverName,
				destination,
				{
					edus: pending.map((p) => p.edu),
				},
			);
			delivered = resp.status < 400;
		} catch {
			delivered = false;
		}

		if (!delivered) return; // still unreachable; try again next sweep

		for (const p of pending) {
			await storage.deleteFederationEdu(p.id).catch(() => {});
		}
		// Loop to drain any further backlog beyond this batch.
		if (pending.length < MAX_EDUS_PER_TXN) return;
	}
};

/**
 * Sweep every destination that currently has queued EDUs and attempt a replay.
 * Called once on startup (so a sender that restarted while a peer was down still
 * recovers) and on a periodic timer (so a peer that comes back up is caught up
 * even without new outbound traffic). Failures per destination are isolated.
 */
export const flushAllPendingEdus = async (
	storage: Storage,
	serverName: string,
	federationClient: FederationClient,
): Promise<void> => {
	let destinations: ServerName[];
	try {
		destinations = await storage.getPendingFederationDestinations();
	} catch (err) {
		console.error(
			"flushAllPendingEdus: failed to list pending destinations:",
			(err as Error).message,
		);
		return;
	}
	for (const destination of destinations) {
		if (destination === serverName) continue;
		await flushPendingEdusForDestination(
			storage,
			serverName,
			federationClient,
			destination,
		).catch((err: Error) =>
			console.error(
				`flushAllPendingEdus: replay to ${destination} failed:`,
				err.message,
			),
		);
	}
};

/**
 * Collect the distinct remote servers (excluding our own) that are resident in
 * any of the supplied rooms. Lookup failures for an individual room are
 * swallowed (logged) so a single bad room never aborts EDU fanout for the rest.
 */
const collectRemoteServers = async (
	storage: Storage,
	serverName: string,
	roomIds: RoomId[],
): Promise<ServerName[]> => {
	const destinations = new Set<ServerName>();
	for (const roomId of roomIds) {
		let servers: ServerName[];
		try {
			servers = await storage.getServersInRoom(roomId);
		} catch (err) {
			console.error(
				`fanoutEdu: failed to resolve servers in room ${roomId}:`,
				(err as Error).message,
			);
			continue;
		}
		for (const s of servers) {
			if (s && s !== serverName) destinations.add(s as ServerName);
		}
	}
	return [...destinations];
};

/**
 * Send a single Ephemeral Data Unit (typing/presence/etc.) to every remote
 * server resident in any of the given rooms (excluding our own server). Unlike
 * PDUs, EDUs are not signed individually — only the wrapping X-Matrix request is
 * signed (handled by FederationClient). Per-destination delivery is
 * fire-and-forget: each PUT is launched without awaiting, and any error is
 * caught and logged but never propagated. The function only awaits the (local)
 * lookup of resident servers.
 *
 * Transient EDUs (typing/presence) are best-effort: a destination that is
 * offline simply misses the update, which is acceptable (the next update
 * supersedes it). Pass `durable: true` for EDUs that MUST eventually arrive even
 * across a destination outage (device-list updates) — those route through
 * `deliverEduToDestination`, which persists and replays on recovery.
 */
export const fanoutEdu = async (
	storage: Storage,
	serverName: string,
	_signingKey: SigningKey,
	federationClient: FederationClient,
	roomIds: RoomId | RoomId[],
	edu: EDU,
	durable = false,
): Promise<void> => {
	const rooms = Array.isArray(roomIds) ? roomIds : [roomIds];
	const destinations = await collectRemoteServers(storage, serverName, rooms);
	if (destinations.length === 0) return;

	for (const destination of destinations) {
		if (durable) {
			// Durable path: persist-on-failure + replay-on-recovery. Awaited so a
			// crash before enqueue cannot lose the EDU, but errors are isolated
			// per destination inside deliverEduToDestination.
			await deliverEduToDestination(
				storage,
				serverName,
				federationClient,
				destination,
				edu,
			);
			continue;
		}

		deliverFireAndForget(
			federationClient,
			serverName,
			destination,
			{ edus: [edu] },
			`fanoutEdu: ${edu.edu_type} EDU`,
		);
	}
};

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
	exclude?: ServerName[],
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

	const excludeSet = new Set([serverName, ...(exclude ?? [])]);
	const destinations = servers.filter((s) => s && !excludeSet.has(s));

	for (const destination of destinations) {
		deliverFireAndForget(
			federationClient,
			serverName,
			destination,
			{ pdus: [event] },
			`fanoutEvent: ${eventId}`,
		);
	}
};
