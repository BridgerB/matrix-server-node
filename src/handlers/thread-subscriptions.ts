import { MatrixError, notFound } from "../errors.ts";
import { KEY_SEP } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { MatrixErrorCode } from "../types/errors.ts";
import type { EventId, RoomId, UserId } from "../types/index.ts";

/**
 * MSC4306: Thread Subscriptions.
 *
 * Implements per-user subscriptions to threads. A user may subscribe to a
 * thread (identified by its thread root event) either manually or
 * automatically (in response to activity in the thread). The endpoints live
 * under the unstable prefix `io.element.msc4306`:
 *
 *   PUT    /rooms/{roomId}/thread/{threadRootId}/subscription   (subscribe)
 *   GET    /rooms/{roomId}/thread/{threadRootId}/subscription   (read)
 *   DELETE /rooms/{roomId}/thread/{threadRootId}/subscription   (unsubscribe)
 *
 * MSC4308 surfaces these subscriptions in the simplified sliding-sync
 * response via the `io.element.msc4308.thread_subscriptions` extension; the
 * exported `getThreadSubscriptionsForSync` helper feeds that extension.
 *
 * Storage: the `Storage` interface cannot be extended here, so subscriptions
 * are held in a module-level Map. This is in-memory only (matching the
 * server's `MemoryStorage` backend) and is keyed by (userId, roomId,
 * threadRootId). Each entry tracks whether the subscription is automatic and
 * a monotonic `bumpStamp` (the storage stream position at write time) used by
 * incremental sliding sync to detect changes. To resolve the MSC4306
 * "ordering conflict" rule we also remember, per thread, the timeline length
 * at the moment of the most recent unsubscribe so that an automatic
 * subscription whose cause event predates that unsubscribe is rejected.
 */

interface ThreadSubscription {
	automatic: boolean;
	bumpStamp: number;
}

interface ThreadState {
	subscription?: ThreadSubscription;
	/**
	 * Timeline ordinal (count of events in the room) recorded at the most
	 * recent unsubscribe. Automatic subscriptions caused by an event at an
	 * ordinal strictly less than this value are considered conflicting.
	 */
	unsubscribedAtOrdinal?: number;
}

// (userId, roomId, threadRootId) -> ThreadState
const store = new Map<string, ThreadState>();

/**
 * Monotonic counter used to stamp every subscription write. We cannot reuse
 * the storage stream position because subscribing does not store an event, so
 * the stream position can stay constant across a subscribe. Incremental
 * sliding sync compares `bumpStamp` against the `pos` it last returned (which
 * is a storage stream position); to guarantee a brand-new subscription is
 * always newer than any previously-returned `pos`, we seed this counter above
 * the current stream position and increment it on every write.
 */
let bumpCounter = 0;

const nextBumpStamp = (streamPosition: number): number => {
	bumpCounter = Math.max(bumpCounter, streamPosition) + 1;
	return bumpCounter;
};

const stateKey = (
	userId: string,
	roomId: string,
	threadRootId: string,
): string => `${userId}${KEY_SEP}${roomId}${KEY_SEP}${threadRootId}`;

const matrixError = (
	errcode: string,
	error: string,
	statusCode: number,
): MatrixError =>
	new MatrixError(errcode as MatrixErrorCode, error, statusCode);

/**
 * Return the 0-based ordinal of `eventId` within the room's forward timeline,
 * or undefined if the event is not in the room. Also returns the total number
 * of events in the room timeline (used as the ordinal marker for unsubscribes).
 */
const getRoomTimelineInfo = async (
	storage: Storage,
	roomId: RoomId,
	eventId?: EventId,
): Promise<{ ordinal?: number; total: number }> => {
	const { events } = await storage.getEventsByRoom(roomId, 100000, 0, "f");
	let ordinal: number | undefined;
	if (eventId !== undefined) {
		const idx = events.findIndex((e) => e.eventId === eventId);
		if (idx >= 0) ordinal = idx;
	}
	return { ordinal, total: events.length };
};

/**
 * Verify a thread root exists in the given room. Throws 404 otherwise.
 */
const requireThreadRoot = async (
	storage: Storage,
	roomId: RoomId,
	threadRootId: EventId,
): Promise<void> => {
	const ev = await storage.getEvent(threadRootId);
	if (!ev || ev.event.room_id !== roomId) {
		throw notFound("Thread root event not found");
	}
};

export const putThreadSubscription =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const threadRootId = req.params.threadRootId as EventId;

		await requireThreadRoot(storage, roomId, threadRootId);

		const body = (req.body ?? {}) as { automatic?: unknown };
		const automaticCause = body.automatic;

		const key = stateKey(userId, roomId, threadRootId);
		const existing = store.get(key) ?? {};

		if (automaticCause !== undefined && automaticCause !== null) {
			// Automatic subscription. `automatic` carries the event ID that
			// caused the subscription; validate it really belongs to this thread.
			if (typeof automaticCause !== "string") {
				throw matrixError(
					"M_BAD_JSON",
					"`automatic` must be an event ID string",
					400,
				);
			}
			const causeId = automaticCause as EventId;

			const causeEvent = await storage.getEvent(causeId);
			const relatesTo =
				causeEvent &&
				((causeEvent.event.content as Record<string, unknown>)[
					"m.relates_to"
				] as { rel_type?: string; event_id?: string } | undefined);

			const isInThread =
				!!causeEvent &&
				causeEvent.event.room_id === roomId &&
				relatesTo?.rel_type === "m.thread" &&
				relatesTo?.event_id === threadRootId;

			if (!isInThread) {
				throw matrixError(
					"IO.ELEMENT.MSC4306.M_NOT_IN_THREAD",
					"The cause event is not part of the specified thread",
					400,
				);
			}

			// If the user explicitly unsubscribed after this cause event was
			// sent, refuse to (re-)create an automatic subscription for it.
			if (existing.unsubscribedAtOrdinal !== undefined) {
				const { ordinal } = await getRoomTimelineInfo(storage, roomId, causeId);
				if (ordinal !== undefined && ordinal < existing.unsubscribedAtOrdinal) {
					throw matrixError(
						"IO.ELEMENT.MSC4306.M_CONFLICTING_UNSUBSCRIPTION",
						"A more recent unsubscription conflicts with this automatic subscription",
						409,
					);
				}
			}

			// Automatic subscriptions never overwrite an existing subscription.
			if (existing.subscription) {
				return { status: 200, body: {} };
			}

			const bumpStamp = nextBumpStamp(await storage.getStreamPosition());
			store.set(key, {
				...existing,
				subscription: { automatic: true, bumpStamp },
			});
			return { status: 200, body: {} };
		}

		// Manual subscription. Always (re)sets the subscription and clears any
		// prior unsubscribe marker; manual subscriptions overwrite automatic.
		const bumpStamp = nextBumpStamp(await storage.getStreamPosition());
		store.set(key, {
			subscription: { automatic: false, bumpStamp },
		});
		return { status: 200, body: {} };
	};

export const getThreadSubscription =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const threadRootId = req.params.threadRootId as EventId;

		await requireThreadRoot(storage, roomId, threadRootId);

		const state = store.get(stateKey(userId, roomId, threadRootId));
		if (!state?.subscription) {
			throw notFound("Not subscribed to this thread");
		}

		return {
			status: 200,
			body: { automatic: state.subscription.automatic },
		};
	};

export const deleteThreadSubscription =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const threadRootId = req.params.threadRootId as EventId;

		await requireThreadRoot(storage, roomId, threadRootId);

		const key = stateKey(userId, roomId, threadRootId);
		const existing = store.get(key) ?? {};

		// Record the current timeline length so that any later automatic
		// subscription caused by an event sent at-or-before now is rejected.
		const { total } = await getRoomTimelineInfo(storage, roomId);
		store.set(key, {
			...existing,
			subscription: undefined,
			unsubscribedAtOrdinal: total,
		});

		// Idempotent: succeeds whether or not a subscription existed.
		return { status: 200, body: {} };
	};

/**
 * MSC4308 sliding-sync helper. Returns the user's current thread
 * subscriptions, optionally filtered to those changed since `since` (the
 * incremental sliding-sync stream position). Shape:
 *   { roomId: { threadRootId: { automatic: bool, bump_stamp: number } } }
 */
export const getThreadSubscriptionsForSync = (
	userId: UserId,
	since?: number,
): Record<
	string,
	Record<string, { automatic: boolean; bump_stamp: number }>
> => {
	const prefix = `${userId}${KEY_SEP}`;
	const result: Record<
		string,
		Record<string, { automatic: boolean; bump_stamp: number }>
	> = {};

	for (const [key, state] of store) {
		if (!key.startsWith(prefix)) continue;
		if (!state.subscription) continue;
		if (since !== undefined && state.subscription.bumpStamp <= since) continue;

		const parts = key.split(KEY_SEP);
		const roomId = parts[1]!;
		const threadRootId = parts[2]!;

		(result[roomId] ??= {})[threadRootId] = {
			automatic: state.subscription.automatic,
			bump_stamp: state.subscription.bumpStamp,
		};
	}

	return result;
};
