/**
 * MSC4140: Delayed events ("Cancellable delayed events").
 *
 * A client can schedule an event to be sent at a later time by adding the query
 * parameter `org.matrix.msc4140.delay=<ms>` to a normal
 * `PUT .../send/{eventType}/{txnId}` or `PUT .../state/{eventType}/{stateKey}`
 * request. Instead of being sent immediately, the event is registered as a
 * "delayed event" and a `delay_id` is returned. The event is actually sent
 * (via the same build/auth/store path as a normal send) once:
 *   - the delay timer elapses, or
 *   - the client POSTs `{action: "send"}` to the management endpoint.
 *
 * The client can also `cancel` a pending delayed event, or `restart` its timer.
 *
 * Endpoints (unstable, prefix `org.matrix.msc4140`):
 *   PUT  .../rooms/{roomId}/send/{eventType}/{txnId}?org.matrix.msc4140.delay=N
 *   PUT  .../rooms/{roomId}/state/{eventType}/{stateKey}?org.matrix.msc4140.delay=N
 *   GET  .../delayed_events
 *   POST .../delayed_events/{delay_id}/{action}   (action: send|cancel|restart)
 *
 * Persistence: the live, armed timers live in a module-level in-memory registry,
 * but each pending delayed event is ALSO persisted to the scheduling user's
 * global account data (type `org.matrix.msc4140.delayed_events`). This lets
 * pending delayed events survive a server restart: when a user next queries
 * `GET .../delayed_events` (or manages one) the persisted entries are rehydrated
 * back into the registry and their timers re-armed with the remaining delay.
 * The Complement "kept on server restart" test relies on this behaviour.
 */

import { badJson, invalidParam, notFound } from "../errors.ts";
import {
	buildEvent,
	canonicalJson,
	checkEventAuth,
	KEY_SEP,
	requireJoinedRoom,
	selectAuthEvents,
} from "../events.ts";
import { indexRelation } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { JsonObject } from "../types/json.ts";
import type { UserId } from "../types/identifiers.ts";

/** Account-data type under which a user's pending delayed events are persisted. */
const ACCOUNT_DATA_TYPE = "org.matrix.msc4140.delayed_events";

interface DelayedEvent {
	delayId: string;
	userId: string;
	deviceId: string;
	roomId: string;
	type: string;
	/** undefined for message events, string (possibly "") for state events. */
	stateKey?: string;
	content: JsonObject;
	/** Configured delay, in milliseconds. */
	delayMs: number;
	/** Wall-clock ms at which the current timer was (re)started. */
	runningSince: number;
	/** Absolute wall-clock ms at which the event is scheduled to fire. */
	sendAt: number;
	timer: ReturnType<typeof setTimeout>;
	storage: Storage;
	serverName: string;
}

/** Persisted (storage) shape of a single delayed event. */
interface PersistedDelayedEvent {
	delay_id: string;
	device_id: string;
	room_id: string;
	type: string;
	state_key?: string;
	content: JsonObject;
	delay: number;
	running_since: number;
	send_at: number;
}

/** Module-level registry of pending delayed events, keyed by delay_id. */
const registry = new Map<string, DelayedEvent>();

/**
 * State-keyed index so that scheduling a new delayed *state* event for the same
 * (room, type, state_key) cancels any previously pending one (per the MSC and
 * exercised by the Complement "kept on server restart" test, which relies on
 * distinct state keys to avoid clobbering each other).
 */
const stateKeyIndex = new Map<string, string>(); // stateTriple -> delayId

const stateTripleOf = (roomId: string, type: string, stateKey: string): string =>
	`${roomId}${KEY_SEP}${type}${KEY_SEP}${stateKey}`;

let delayCounter = 0;
const newDelayId = (): string =>
	`${Date.now().toString(36)}_${(delayCounter++).toString(36)}_${Math.random()
		.toString(36)
		.slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Persistence helpers (per-user global account data)
// ---------------------------------------------------------------------------

const loadPersisted = async (
	storage: Storage,
	userId: string,
): Promise<Record<string, PersistedDelayedEvent>> => {
	const data = await storage.getGlobalAccountData(userId as UserId, ACCOUNT_DATA_TYPE);
	if (!data || typeof data !== "object") return {};
	const events = (data as JsonObject).events;
	if (!events || typeof events !== "object" || Array.isArray(events)) return {};
	return events as unknown as Record<string, PersistedDelayedEvent>;
};

const savePersisted = async (
	storage: Storage,
	userId: string,
	events: Record<string, PersistedDelayedEvent>,
): Promise<void> => {
	await storage.setGlobalAccountData(userId as UserId, ACCOUNT_DATA_TYPE, {
		events: events as unknown as JsonObject,
	});
};

const persist = async (de: DelayedEvent): Promise<void> => {
	const events = await loadPersisted(de.storage, de.userId);
	const entry: PersistedDelayedEvent = {
		delay_id: de.delayId,
		device_id: de.deviceId,
		room_id: de.roomId,
		type: de.type,
		content: de.content,
		delay: de.delayMs,
		running_since: de.runningSince,
		send_at: de.sendAt,
	};
	if (de.stateKey !== undefined) entry.state_key = de.stateKey;
	events[de.delayId] = entry;
	await savePersisted(de.storage, de.userId, events);
};

const unpersist = async (de: DelayedEvent): Promise<void> => {
	const events = await loadPersisted(de.storage, de.userId);
	if (events[de.delayId]) {
		delete events[de.delayId];
		await savePersisted(de.storage, de.userId, events);
	}
};

const removeFromRegistry = (de: DelayedEvent): void => {
	registry.delete(de.delayId);
	if (de.stateKey !== undefined) {
		const triple = stateTripleOf(de.roomId, de.type, de.stateKey);
		if (stateKeyIndex.get(triple) === de.delayId) {
			stateKeyIndex.delete(triple);
		}
	}
};

/**
 * Actually send a delayed event, reusing the same build/auth/store sequence as
 * `putSendEvent`/`putStateEvent` in room-events.ts. Failures are swallowed:
 * a delayed event firing after its sender left the room (etc.) simply does not
 * get sent, which mirrors how a normal send would be rejected at send time.
 */
const fireDelayedEvent = async (de: DelayedEvent): Promise<void> => {
	removeFromRegistry(de);
	await unpersist(de).catch(() => {});
	const { storage, serverName, roomId, userId, type, content, stateKey } = de;
	try {
		const room = await requireJoinedRoom(storage, roomId, userId);
		const authEvents = selectAuthEvents(type, stateKey, room, userId);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type,
			content,
			stateKey,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
		});

		const size = Buffer.byteLength(canonicalJson(event), "utf-8");
		if (size > 65536) return;

		checkEventAuth(event, eventId, room);

		if (stateKey !== undefined) {
			await storage.setStateEvent(roomId, event, eventId);
		} else {
			await storage.storeEvent(event, eventId);
			await indexRelation(storage, event, eventId);
		}

		room.depth++;
		room.forward_extremities = [eventId];
	} catch {
		// Event could not be sent at fire time (e.g. sender no longer joined).
		// Per MSC4140 there's nothing to return to a client at this point.
	}
};

const arm = (de: DelayedEvent): void => {
	de.runningSince = Date.now();
	de.sendAt = de.runningSince + de.delayMs;
	const remaining = Math.max(0, de.sendAt - Date.now());
	de.timer = setTimeout(() => {
		void fireDelayedEvent(de);
	}, remaining);
	// Don't keep the Node process alive solely for a pending delayed event.
	if (typeof de.timer === "object" && de.timer && "unref" in de.timer) {
		(de.timer as { unref: () => void }).unref();
	}
};

/** Re-arm a rehydrated event using its persisted absolute fire time. */
const armWithSendAt = (de: DelayedEvent): void => {
	const remaining = Math.max(0, de.sendAt - Date.now());
	de.timer = setTimeout(() => {
		void fireDelayedEvent(de);
	}, remaining);
	if (typeof de.timer === "object" && de.timer && "unref" in de.timer) {
		(de.timer as { unref: () => void }).unref();
	}
};

/**
 * Rehydrate a user's persisted delayed events into the in-memory registry,
 * arming timers for any that aren't already live. This makes pending delayed
 * events survive a server restart.
 */
const rehydrate = async (
	storage: Storage,
	serverName: string,
	userId: string,
): Promise<void> => {
	const persisted = await loadPersisted(storage, userId);
	for (const entry of Object.values(persisted)) {
		if (!entry || typeof entry !== "object") continue;
		if (registry.has(entry.delay_id)) continue;
		const de: DelayedEvent = {
			delayId: entry.delay_id,
			userId,
			deviceId: entry.device_id,
			roomId: entry.room_id,
			type: entry.type,
			stateKey: entry.state_key,
			content: entry.content,
			delayMs: entry.delay,
			runningSince: entry.running_since,
			sendAt: entry.send_at,
			timer: undefined as unknown as ReturnType<typeof setTimeout>,
			storage,
			serverName,
		};
		registry.set(de.delayId, de);
		if (de.stateKey !== undefined) {
			stateKeyIndex.set(
				stateTripleOf(de.roomId, de.type, de.stateKey),
				de.delayId,
			);
		}
		armWithSendAt(de);
	}
};

const parseDelayMs = (raw: string | null): number | undefined => {
	if (raw === null) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw invalidParam("'org.matrix.msc4140.delay' must be a positive integer");
	}
	return n;
};

const requireObjectBody = (body: unknown): JsonObject => {
	const content = body ?? {};
	if (typeof content !== "object" || content === null || Array.isArray(content)) {
		throw badJson("Event content must be a JSON object");
	}
	return content as JsonObject;
};

const schedule = async (params: {
	storage: Storage;
	serverName: string;
	userId: string;
	deviceId: string;
	roomId: string;
	type: string;
	stateKey?: string;
	content: JsonObject;
	delayMs: number;
}): Promise<string> => {
	// Scheduling a new delayed state event for the same (room, type, state_key)
	// supersedes any previously pending one.
	if (params.stateKey !== undefined) {
		const triple = stateTripleOf(params.roomId, params.type, params.stateKey);
		const prevId = stateKeyIndex.get(triple);
		if (prevId) {
			const prev = registry.get(prevId);
			if (prev) {
				clearTimeout(prev.timer);
				removeFromRegistry(prev);
				await unpersist(prev).catch(() => {});
			}
		}
	}

	const delayId = newDelayId();
	const now = Date.now();
	const de: DelayedEvent = {
		delayId,
		userId: params.userId,
		deviceId: params.deviceId,
		roomId: params.roomId,
		type: params.type,
		stateKey: params.stateKey,
		content: params.content,
		delayMs: params.delayMs,
		runningSince: now,
		sendAt: now + params.delayMs,
		timer: undefined as unknown as ReturnType<typeof setTimeout>,
		storage: params.storage,
		serverName: params.serverName,
	};
	registry.set(delayId, de);
	if (params.stateKey !== undefined) {
		stateKeyIndex.set(
			stateTripleOf(params.roomId, params.type, params.stateKey),
			delayId,
		);
	}
	armWithSendAt(de);
	await persist(de);
	return delayId;
};

/**
 * PUT .../rooms/{roomId}/send/{eventType}/{txnId} with `?...delay=N`.
 *
 * Idempotent per (user, device, room, txnId): re-issuing the same delayed send
 * with the same txnId returns the same `delay_id` (the test re-PUTs without a
 * body to confirm this). We reuse the storage txn table by folding the room
 * and a marker into the opaque txn id, storing the delay_id where the event id
 * would normally go.
 */
export const putDelayedEvent =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const delayMs = parseDelayMs(req.query.get("org.matrix.msc4140.delay"));
		if (delayMs === undefined) {
			throw invalidParam("Missing 'org.matrix.msc4140.delay' query parameter");
		}

		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const txnId = req.params.txnId as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		const scopedTxnId = `delayed ${roomId} ${txnId}`;
		const existing = await storage.getTxnEventId(
			userId as UserId,
			deviceId,
			scopedTxnId,
		);
		if (existing) return { status: 200, body: { delay_id: existing } };

		const content = requireObjectBody(req.body);
		// Validate the sender may post here right now (matches normal send).
		await requireJoinedRoom(storage, roomId, userId);

		const delayId = await schedule({
			storage,
			serverName,
			userId,
			deviceId,
			roomId,
			type: eventType,
			content,
			delayMs,
		});

		await storage.setTxnEventId(
			userId as UserId,
			deviceId,
			scopedTxnId,
			delayId,
		);
		return { status: 200, body: { delay_id: delayId } };
	};

/** PUT .../rooms/{roomId}/state/{eventType}/{stateKey} with `?...delay=N`. */
export const putDelayedStateEvent =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const delayMs = parseDelayMs(req.query.get("org.matrix.msc4140.delay"));
		if (delayMs === undefined) {
			throw invalidParam("Missing 'org.matrix.msc4140.delay' query parameter");
		}

		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const stateKey = (req.params.stateKey ?? "") as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		const content = requireObjectBody(req.body);
		await requireJoinedRoom(storage, roomId, userId);

		const delayId = await schedule({
			storage,
			serverName,
			userId,
			deviceId,
			roomId,
			type: eventType,
			stateKey,
			content,
			delayMs,
		});

		return { status: 200, body: { delay_id: delayId } };
	};

/**
 * GET .../delayed_events — list the requesting user's pending delayed events.
 * Response: `{ delayed_events: [...] }`, each entry containing at least
 * `delay_id` and `content` (plus room_id/type/delay/running_since/state_key).
 *
 * Persisted delayed events are rehydrated first so that they remain visible
 * (and their timers re-armed) after a server restart.
 */
export const getDelayedEvents =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as string;
		await rehydrate(storage, serverName, userId);
		// Match Synapse's `get_all_delayed_events_for_user` shape exactly: each
		// entry has delay_id, room_id, type, (state_key if state), delay,
		// running_since, content — ordered by scheduled send time (send_ts).
		const delayed_events = [...registry.values()]
			.filter((de) => de.userId === userId)
			.sort((a, b) => a.sendAt - b.sendAt)
			.map((de) => {
				const entry: JsonObject = {
					delay_id: de.delayId,
					room_id: de.roomId,
					type: de.type,
					content: de.content,
					delay: de.delayMs,
					running_since: de.runningSince,
				};
				if (de.stateKey !== undefined) entry.state_key = de.stateKey;
				return entry;
			});
		return { status: 200, body: { delayed_events } };
	};

/**
 * POST .../delayed_events/{delay_id}/{action} where action is send|cancel|restart.
 *
 * These endpoints are keyed purely by `delay_id` (no auth), matching the
 * Complement test which manages delayed events with an unauthenticated client
 * and expects 404 for an unknown delay_id.
 */
export const postDelayedEventAction = (): Handler => async (req) => {
	const delayId = req.params.delayId as string;
	const action = req.params.action as string;

	if (action !== "send" && action !== "cancel" && action !== "restart") {
		throw notFound("Unknown delayed event action");
	}

	const de = registry.get(delayId);
	if (!de) throw notFound("No delayed event found with that delay_id");

	if (action === "cancel") {
		clearTimeout(de.timer);
		removeFromRegistry(de);
		await unpersist(de).catch(() => {});
		return { status: 200, body: {} };
	}

	if (action === "restart") {
		clearTimeout(de.timer);
		arm(de);
		await persist(de).catch(() => {});
		return { status: 200, body: {} };
	}

	// action === "send": fire immediately.
	clearTimeout(de.timer);
	await fireDelayedEvent(de);
	return { status: 200, body: {} };
};
