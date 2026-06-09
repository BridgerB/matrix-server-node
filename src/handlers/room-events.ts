import { MatrixError } from "../errors.ts";
import {
	badAlias,
	badJson,
	forbidden,
	invalidParam,
	missingParam,
	notFound,
} from "../errors.ts";
import {
	parseRegistrations,
	findAppserviceForUser,
} from "../appservice/registration.ts";
import {
	buildEvent,
	canonicalJson,
	checkEventAuth,
	computeContentHash,
	computeEventId,
	getMembership,
	getPowerLevels,
	getUserPowerLevel,
	isWorldReadable,
	KEY_SEP,
	pduToClientEvent,
	redactEvent,
	requireJoinedOrWorldReadable,
	requireJoinedRoom,
	selectAuthEvents,
} from "../events.ts";
import { signEvent } from "../signing.ts";
import {
	matchesRoomEventFilter,
	parseRoomEventFilter,
} from "../event-filter.ts";
import type { FederationClient } from "../federation/client.ts";
import { verifyOriginSignature } from "../federation/verify.ts";
import { fanoutEvent } from "../federation/outbound.ts";
import { getIgnoredUsers } from "../ignored-users.ts";
import { bundleAggregations, indexRelation } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, PDU, RoomAlias, RoomId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

/**
 * Access control for single-event fetch endpoints (`/event/:eventId`,
 * `/context/:eventId`). Per the spec these endpoints hide the existence of
 * rooms/events the requester cannot see, so every "you can't see this" case —
 * whether the room is missing, the user isn't a member, or the room is not
 * world-readable — must surface as HTTP 404 (M_NOT_FOUND) rather than 403.
 *
 * This intentionally differs from `requireJoinedOrWorldReadable`, which throws
 * 403/404 in a way appropriate for listing endpoints (e.g. `/messages`,
 * `/state`, `/members`). We resolve access here locally instead of editing the
 * shared helper so we don't change behaviour for those other callers.
 */
const requireCanReadEventOr404 = async (
	storage: Storage,
	roomId: string,
	userId: string | undefined,
): Promise<void> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw notFound("Event not found");
	if (userId && getMembership(room, userId as UserId) === "join") return;
	if (isWorldReadable(room)) return;
	throw notFound("Event not found");
};

/**
 * Per-event history-visibility check for single-event fetch endpoints
 * (`/event/:eventId`, `/context/:eventId`). Even when the requester is currently
 * joined, the room's `m.room.history_visibility` constrains *which* events they
 * may read:
 *
 *   - `world_readable` / `shared`: every event is visible.
 *   - `invited`: only events from when the user was invited or joined.
 *   - `joined`: only events from when the user was joined.
 *
 * To enforce `joined`/`invited` we replay the room timeline up to (and
 * including) the target event and track the requester's membership at that
 * point. If their membership at the event's position does not grant access, the
 * event is hidden — surfaced as 404 to match `requireCanReadEventOr404`.
 *
 * `world_readable`/`shared` rooms (the common case) short-circuit without any
 * timeline walk.
 */
const requireHistoryVisibleOr404 = async (
	storage: Storage,
	roomId: string,
	eventId: string,
	userId: string | undefined,
): Promise<void> => {
	const room = await storage.getRoom(roomId);
	if (!room) throw notFound("Event not found");

	const hvEvent = room.state_events.get("m.room.history_visibility\x1f");
	const visibility =
		hvEvent &&
		typeof (hvEvent.content as Record<string, unknown>).history_visibility ===
			"string"
			? ((hvEvent.content as Record<string, unknown>)
					.history_visibility as string)
			: "shared";

	// shared / world_readable place no per-event restriction beyond the
	// room-level access check already performed by requireCanReadEventOr404.
	if (visibility !== "joined" && visibility !== "invited") return;
	if (!userId) throw notFound("Event not found");

	// Walk the full timeline in ascending stream order, tracking this user's
	// membership and the active history_visibility, until we reach the target
	// event. We then decide based on the membership/visibility at that point.
	const all = await storage.getEventsByRoomSince(roomId as RoomId, 0, 1_000_000);
	let membership: string | undefined;
	let activeVisibility = "shared";
	let found = false;

	for (const e of all.events) {
		const ev = e.event;

		if (
			ev.type === "m.room.history_visibility" &&
			ev.state_key === "" &&
			typeof (ev.content as Record<string, unknown>).history_visibility ===
				"string"
		) {
			activeVisibility = (ev.content as Record<string, unknown>)
				.history_visibility as string;
		}

		// The target event is visible if, at the moment it was sent, the
		// requester's membership satisfies the then-active visibility. For
		// `joined` they must already be joined; for `invited`, joined or
		// invited. (Membership is evaluated *before* applying the target event
		// itself, so a user's own join event is not retroactively visible under
		// `joined`.)
		if (e.eventId === eventId) {
			found = true;
			if (activeVisibility === "joined" && membership !== "join") {
				throw notFound("Event not found");
			}
			if (
				activeVisibility === "invited" &&
				membership !== "join" &&
				membership !== "invite"
			) {
				throw notFound("Event not found");
			}
			break;
		}

		if (ev.type === "m.room.member" && ev.state_key === userId) {
			const m = (ev.content as Record<string, unknown>).membership;
			if (typeof m === "string") membership = m;
		}
	}

	// If the event isn't in the timeline at all, leave the not-found decision to
	// the caller's getEvent lookup.
	if (!found) return;
};

/** A well-formed room alias is `#localpart:server_name`. */
const isWellFormedAlias = (alias: unknown): alias is string => {
	if (typeof alias !== "string" || !alias.startsWith("#")) return false;
	const colon = alias.indexOf(":");
	return colon > 1 && colon < alias.length - 1;
};

/**
 * Validate the content of an `m.room.canonical_alias` event: every alias listed
 * (the primary `alias` and each of `alt_aliases`) must be well-formed and must
 * resolve, in the local directory, to this room. Throws M_INVALID_PARAM for a
 * malformed alias and M_BAD_ALIAS for one that is missing or points elsewhere.
 */
const validateCanonicalAlias = async (
	storage: Storage,
	roomId: string,
	content: JsonObject,
): Promise<void> => {
	const candidates: unknown[] = [];
	if (content.alias !== undefined) candidates.push(content.alias);
	if (Array.isArray(content.alt_aliases)) candidates.push(...content.alt_aliases);

	for (const candidate of candidates) {
		if (!isWellFormedAlias(candidate)) {
			throw invalidParam(`Invalid alias: ${String(candidate)}`);
		}
		const resolved = await storage.getRoomByAlias(candidate as RoomAlias);
		if (!resolved || resolved.room_id !== (roomId as RoomId)) {
			throw badAlias(`Alias ${candidate} does not point to this room`);
		}
	}
};

/**
 * Resolve the `?ts=<ms>` query param for an event send. Per the Client-Server
 * spec, application services may backdate (or post-date) events by supplying a
 * `ts` query parameter giving the desired `origin_server_ts` in milliseconds.
 * This is the mechanism bridges use to import historical messages and is what
 * the MSC3030 jump-to-date (`/timestamp_to_event`) tests exercise.
 *
 * We only honour `ts` when the authenticated requester is an application service
 * user (their user ID falls within a registered AS user namespace). Regular
 * users never get to set `origin_server_ts`. Returns `undefined` when no valid
 * override applies, in which case `buildEvent` uses `Date.now()` as normal.
 */
const resolveTsOverride = (
	req: { query: URLSearchParams; userId?: string },
): number | undefined => {
	const tsStr = req.query.get("ts");
	if (tsStr === null) return undefined;
	if (!req.userId) return undefined;

	const registrations = parseRegistrations();
	if (!findAppserviceForUser(req.userId, registrations)) return undefined;

	const ts = parseInt(tsStr, 10);
	if (Number.isNaN(ts)) throw invalidParam("'ts' must be an integer");
	return ts;
};

/**
 * Apply an `origin_server_ts` override to a freshly built event. Because the
 * timestamp is part of the hashed/signed content, the content hash, event ID and
 * signature must all be recomputed — this mirrors `buildEvent` exactly, just
 * with the caller-supplied timestamp instead of `Date.now()`. Returns the new
 * (event, eventId) pair; the original `eventId` is no longer valid.
 */
const applyTsOverride = (
	event: PDU,
	originServerTs: number,
	serverName: string,
	signingKey?: SigningKey,
	roomVersion?: string,
): { event: PDU; eventId: EventId } => {
	// Build the unsigned, hash-able form: drop the prior hash/signatures so the
	// recompute below starts from clean content (buildEvent does the same).
	const rebuilt: PDU = {
		...event,
		origin_server_ts: originServerTs,
		hashes: { sha256: "" },
		signatures: { [serverName]: {} },
	};
	delete (rebuilt as { unsigned?: unknown }).unsigned;

	rebuilt.hashes = { sha256: computeContentHash(rebuilt) };
	const eventId = computeEventId(rebuilt, roomVersion);

	if (signingKey) {
		return {
			event: signEvent(rebuilt, serverName, signingKey, roomVersion),
			eventId,
		};
	}
	return { event: rebuilt, eventId };
};

export const putSendEvent =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const txnId = req.params.txnId as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		// Transaction idempotency is scoped to (user, device, room, txnId): the
		// same txnId reused in the SAME room must return the SAME event, but the
		// same txnId in a DIFFERENT room must produce a new event. The storage
		// txn key is (user, device, txnId) only, so we fold the room into the
		// opaque txn-id string to scope it per-room without changing storage.
		const scopedTxnId = `${roomId}${KEY_SEP}${txnId}`;

		const existing = await storage.getTxnEventId(userId, deviceId, scopedTxnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		// Validate that body is a JSON object (not array, string, number, null, etc.)
		const content = req.body ?? {};
		if (
			typeof content !== "object" ||
			content === null ||
			Array.isArray(content)
		) {
			throw badJson("Event content must be a JSON object");
		}

		const room = await requireJoinedRoom(storage, roomId, userId);

		const authEvents = selectAuthEvents(eventType, undefined, room, userId);
		// Sign the event (when a signing key is available) so it can be fanned out
		// to remote servers, which reject unsigned PDUs. Signing is additive and
		// does not change the event ID (computed over the redacted form).
		const built = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: content as JsonObject,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
			signingKey,
			roomVersion: room.room_version,
		});

		// Application services may backdate events via `?ts=<ms>`. Since the
		// timestamp is hashed/signed, this re-derives the event ID and signature.
		const tsOverride = resolveTsOverride(req);
		const { event, eventId } =
			tsOverride !== undefined
				? applyTsOverride(built.event, tsOverride, serverName, signingKey, room.room_version)
				: built;

		const eventSize = Buffer.byteLength(canonicalJson(event), "utf-8");
		if (eventSize > 65536) {
			throw new MatrixError("M_TOO_LARGE", "Event is too large", 413);
		}

		checkEventAuth(event, eventId, room);

		// Store transaction_id in unsigned for the sender. `unsigned` is excluded
		// from the signed/hashed form, so adding it after signing is safe and does
		// not invalidate the signature.
		event.unsigned = {
			...event.unsigned,
			transaction_id: txnId,
		};

		await storage.storeEvent(event, eventId);
		await indexRelation(storage, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		await storage.setTxnEventId(userId, deviceId, scopedTxnId, eventId);

		// Propagate to remote servers in the room (best-effort, fire-and-forget).
		if (signingKey && federationClient) {
			await fanoutEvent(
				storage,
				serverName,
				signingKey,
				federationClient,
				roomId as RoomId,
				event,
				eventId,
			);
		}

		return { status: 200, body: { event_id: eventId } };
	};

export const putStateEvent =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const stateKey = req.params.stateKey ?? "";
		const userId = req.userId as string;

		// Validate that body is a JSON object
		const rawContent = req.body ?? {};
		if (
			typeof rawContent !== "object" ||
			rawContent === null ||
			Array.isArray(rawContent)
		) {
			throw badJson("Event content must be a JSON object");
		}
		const newContent = rawContent as JsonObject;

		const room = await requireJoinedRoom(storage, roomId, userId);

		if (eventType === "m.room.canonical_alias") {
			await validateCanonicalAlias(storage, roomId, newContent);
		}

		// No-op state dedup (mirrors Synapse's `deduplicate_state_event`): if the
		// room already has a state event of this (type, state_key) whose content is
		// deep-equal to the new content AND was sent by the same user, sending it
		// again is a no-op — return the EXISTING event's ID without creating a
		// duplicate. This prevents redundant history_visibility / etc. events from
		// piling up (and is what TestInboundCanReturnMissingEvents relies on to keep
		// the DAG free of spurious no-op events).
		const existing = await storage.getStateEvent(roomId, eventType, stateKey);
		if (existing) {
			const sameContent =
				canonicalJson(existing.event.content) === canonicalJson(newContent);
			const sameSender = existing.event.sender === userId;
			if (sameContent && sameSender) {
				return { status: 200, body: { event_id: existing.eventId } };
			}
		}

		const authEvents = selectAuthEvents(eventType, stateKey, room, userId);
		// Sign the state event (when a signing key is available) for federation
		// fan-out. Signing does not change the event ID.
		const builtState = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: newContent,
			stateKey,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
			signingKey,
			roomVersion: room.room_version,
		});

		// Application services may backdate state events via `?ts=<ms>`.
		const stateTsOverride = resolveTsOverride(req);
		const { event, eventId } =
			stateTsOverride !== undefined
				? applyTsOverride(
						builtState.event,
						stateTsOverride,
						serverName,
						signingKey,
						room.room_version,
					)
				: builtState;

		const stateEventSize = Buffer.byteLength(canonicalJson(event), "utf-8");
		if (stateEventSize > 65536) {
			throw new MatrixError("M_TOO_LARGE", "Event is too large", 413);
		}

		checkEventAuth(event, eventId, room);
		await storage.setStateEvent(roomId, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		// Propagate to remote servers in the room (best-effort, fire-and-forget).
		if (signingKey && federationClient) {
			await fanoutEvent(
				storage,
				serverName,
				signingKey,
				federationClient,
				roomId as RoomId,
				event,
				eventId,
			);
		}

		return { status: 200, body: { event_id: eventId } };
	};

/** Per-user marker (room account data) set when a user forgets a room. */
const FORGOTTEN_ROOM_MARKER = "m.internal.forgotten";

/** Throw 403 if the user has forgotten this room (read endpoints reject it). */
const assertNotForgotten = async (
	storage: Storage,
	userId: string | undefined,
	roomId: string,
): Promise<void> => {
	if (!userId) return;
	const marker = await storage.getRoomAccountData(
		userId as UserId,
		roomId as RoomId,
		FORGOTTEN_ROOM_MARKER,
	);
	if ((marker as { forgotten?: boolean } | undefined)?.forgotten === true) {
		throw forbidden(`Forgotten room ${roomId} cannot be read`);
	}
};

export const getAllState =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedOrWorldReadable(storage, roomId, req.userId);
		await assertNotForgotten(storage, req.userId, roomId);

		const stateEntries = await storage.getAllState(roomId);
		const events = stateEntries.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		return { status: 200, body: events };
	};

export const getStateEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const stateKey = req.params.stateKey ?? "";

		await requireJoinedOrWorldReadable(storage, roomId, req.userId);
		await assertNotForgotten(storage, req.userId, roomId);

		const entry = await storage.getStateEvent(roomId, eventType, stateKey);
		if (!entry) throw notFound("State event not found");

		const format = req.query.get("format");
		if (format === "event") {
			return {
				status: 200,
				body: pduToClientEvent(entry.event, entry.eventId),
			};
		}

		return { status: 200, body: entry.event.content };
	};

/**
 * Outbound `/messages` backfill (mirrors Synapse's
 * `FederationHandler.maybe_backfill`). When a local user paginates backward
 * (`dir=b`) into a room whose history we only partially hold — typically after
 * joining a remote room via `send_join`, which gives us the current state but
 * not the historical timeline — there is a "gap": events we hold reference
 * `prev_events` we do not. We fill that gap by asking a remote server in the
 * room for the missing events via `GET /_matrix/federation/v1/backfill`.
 *
 * Each returned PDU is verified (content hash, origin signature, event id),
 * deduplicated against storage, persisted, and indexed for relations, exactly
 * as an inbound transaction PDU would be. We run a bounded number of rounds so
 * a hostile/large remote history cannot make a single request unbounded.
 *
 * Returns the number of new events imported across all rounds.
 */
const backfillMissingHistory = async (
	storage: Storage,
	serverName: string,
	federationClient: FederationClient,
	roomId: RoomId,
	roomVersion: string | undefined,
	maxRounds = 2,
): Promise<number> => {
	// Choose a remote server that participates in the room (excluding ourselves).
	const servers = (await storage.getServersInRoom(roomId)).filter(
		(s) => s !== serverName,
	);
	if (servers.length === 0) return 0;

	let imported = 0;

	for (let round = 0; round < maxRounds; round++) {
		// Re-read the timeline each round: previously-imported events extend the
		// known set and shift the gap boundary further back.
		const all = await storage.getEventsByRoom(
			roomId,
			1_000_000,
			undefined,
			"f",
		);
		const known = new Set<EventId>(all.events.map((e) => e.eventId));

		// The backfill "seeds" are the IDs of prev_events we reference but do not
		// hold — the earliest edge of our known DAG. These are exactly the events
		// the remote should walk back from. Synapse seeds from the room's
		// backward extremities; the unknown prev_events are their analogue here.
		const seeds = new Set<EventId>();
		for (const { event } of all.events) {
			for (const prev of event.prev_events) {
				if (!known.has(prev)) seeds.add(prev);
			}
		}
		if (seeds.size === 0) break; // No gap — nothing to backfill.

		const v = [...seeds].slice(0, 10);
		const qs = v
			.map((id) => `v=${encodeURIComponent(id)}`)
			.join("&");
		const path = `/_matrix/federation/v1/backfill/${encodeURIComponent(
			roomId,
		)}?${qs}&limit=100`;

		let roundImported = 0;
		for (const server of servers) {
			let res: { status: number; body: unknown };
			try {
				res = await federationClient.request(server, "GET", path);
			} catch {
				continue; // Try the next server.
			}
			if (res.status !== 200 || typeof res.body !== "object" || res.body === null)
				continue;

			const pdus = (res.body as { pdus?: unknown }).pdus;
			if (!Array.isArray(pdus)) continue;

			for (const raw of pdus) {
				if (!raw || typeof raw !== "object") continue;
				const event = raw as PDU;
				if (event.room_id !== roomId) continue;

				// Verify content hash, then recompute the event id from the content
				// (v4+ event IDs are content hashes) and reject mismatches.
				let eventId: EventId;
				try {
					const expectedHash = computeContentHash(event);
					if (event.hashes?.sha256 !== expectedHash) continue;
					eventId = computeEventId(event, roomVersion);
				} catch {
					continue;
				}

				// Dedupe: skip anything we already hold.
				if (await storage.getEvent(eventId)) continue;

				// Verify the event is correctly signed by its origin server.
				try {
					await verifyOriginSignature(
						event,
						server,
						storage,
						federationClient,
						roomVersion,
					);
				} catch {
					continue;
				}

				await storage.storeEvent(event, eventId);
				await indexRelation(storage, event, eventId);
				imported++;
				roundImported++;
			}

			// One server that produced events is enough for this round.
			if (roundImported > 0) break;
		}

		if (roundImported === 0) break; // No progress — stop.
	}

	return imported;
};

/**
 * Build a complete depth-ordered (ascending) view of every event currently held
 * for a room, deduplicated by event id. After backfill, historical events live
 * at the *newest* stream positions (storage appends by insertion order), so
 * `getEventsByRoom`'s stream-ordered output no longer reflects DAG order. We
 * therefore reorder by `(depth, origin_server_ts, event_id)` ourselves before
 * serving the `/messages` chunk and paginating it.
 */
const buildDepthOrdered = (
	events: { event: PDU; eventId: EventId }[],
): { event: PDU; eventId: EventId }[] => {
	const seen = new Set<EventId>();
	const out: { event: PDU; eventId: EventId }[] = [];
	for (const e of events) {
		if (seen.has(e.eventId)) continue;
		seen.add(e.eventId);
		out.push(e);
	}
	out.sort(
		(a, b) =>
			a.event.depth - b.event.depth ||
			a.event.origin_server_ts - b.event.origin_server_ts ||
			(a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
	);
	return out;
};

export const getMessages =
	(
		storage: Storage,
		serverName?: string,
		_signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const userId = req.userId as UserId;
		// `/messages` is a listing endpoint: a non-member who cannot otherwise
		// see the room (including the case where the room does not exist) must
		// get 403 ("You aren't a member of the room"), NOT 404. This matches
		// Synapse and TestFetchMessagesFromNonExistentRoom. We resolve access
		// locally here so the missing-room case maps to 403 rather than the
		// shared helper's 404.
		const messagesRoom = await storage.getRoom(roomId);
		if (
			!messagesRoom ||
			(getMembership(messagesRoom, userId) !== "join" &&
				!isWorldReadable(messagesRoom))
		) {
			throw forbidden("You aren't a member of the room");
		}
		await assertNotForgotten(storage, userId, roomId);

		const dir = (req.query.get("dir") ?? "f") as "b" | "f";
		if (dir !== "b" && dir !== "f") throw badJson("dir must be 'b' or 'f'");

		const fromStr = req.query.get("from");
		// Backfill pagination tokens are emitted as `b<index>` (a position into the
		// depth-ordered timeline). Plain numeric tokens are stream positions used by
		// the storage-backed pager. Detect the former so we can continue paging the
		// depth-ordered view across requests.
		const isBackfillToken = fromStr !== null && /^b\d+$/.test(fromStr);
		const from = fromStr && !isBackfillToken ? parseInt(fromStr, 10) : undefined;
		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10), 1), 100);

		const filter = parseRoomEventFilter(req.query.get("filter"));

		// MSC3874: filter the timeline by the relation type of each event
		// (`org.matrix.msc3874.rel_types` / `.not_rel_types`). These fields are
		// not part of the standard RoomEventFilter handled by
		// `matchesRoomEventFilter`, so we read them off the parsed filter object
		// and apply them locally here. An event's relation type is
		// `content["m.relates_to"]["rel_type"]` (undefined if it has no relation).
		const relFilter = filter as
			| {
					"org.matrix.msc3874.rel_types"?: string[];
					"org.matrix.msc3874.not_rel_types"?: string[];
			  }
			| undefined;
		const relTypes = Array.isArray(relFilter?.["org.matrix.msc3874.rel_types"])
			? relFilter["org.matrix.msc3874.rel_types"]
			: undefined;
		const notRelTypes = Array.isArray(
			relFilter?.["org.matrix.msc3874.not_rel_types"],
		)
			? relFilter["org.matrix.msc3874.not_rel_types"]
			: undefined;

		const relTypeOf = (e: { content: unknown }): string | undefined => {
			const relatesTo = (e.content as Record<string, unknown> | undefined)?.[
				"m.relates_to"
			];
			if (relatesTo && typeof relatesTo === "object") {
				const rt = (relatesTo as Record<string, unknown>)["rel_type"];
				if (typeof rt === "string") return rt;
			}
			return undefined;
		};

		// Resolve the raw page of events to serve. The normal path is the
		// storage-backed (stream-ordered) pager. For backward pagination into a
		// room whose history we only partially hold, we instead backfill the gap
		// from a remote server and serve a depth-ordered view (see
		// `backfillMissingHistory` / `buildDepthOrdered`). The depth-ordered pager
		// uses `b<index>` tokens so it can be continued across requests.
		let result: {
			events: { event: PDU; eventId: EventId }[];
			end?: number | string;
		};

		// Decide whether to engage the depth-ordered backfill pager. We only do so
		// for backward pagination, when we have the means to federate, and either
		// the client is already paging the depth-ordered view (`b` token) or a gap
		// to events we don't hold currently exists.
		let useBackfillPager = false;
		if (
			dir === "b" &&
			serverName &&
			federationClient &&
			(isBackfillToken || from === undefined)
		) {
			const remoteServers = (
				await storage.getServersInRoom(roomId as RoomId)
			).filter((s) => s !== serverName);
			if (remoteServers.length > 0) {
				const localAll = await storage.getEventsByRoom(
					roomId as RoomId,
					1_000_000,
					undefined,
					"f",
				);
				const known = new Set<EventId>(
					localAll.events.map((e) => e.eventId),
				);
				const hasGap = localAll.events.some((e) =>
					e.event.prev_events.some((p) => !known.has(p)),
				);
				useBackfillPager = isBackfillToken || hasGap;
			}
		}

		if (useBackfillPager && serverName && federationClient) {
			// Pull missing history into storage (bounded rounds), unless we are
			// merely continuing to page an already-backfilled view.
			if (!isBackfillToken) {
				await backfillMissingHistory(
					storage,
					serverName,
					federationClient,
					roomId as RoomId,
					messagesRoom.room_version,
				);
			}

			// Build the depth-ordered ascending timeline and page it backward.
			const localAll = await storage.getEventsByRoom(
				roomId as RoomId,
				1_000_000,
				undefined,
				"f",
			);
			const ordered = buildDepthOrdered(localAll.events);

			// `from` index: the position to read *before* (exclusive). Absent ->
			// start from the newest event (end of the ascending array).
			const fromIdx = isBackfillToken
				? parseInt((fromStr as string).slice(1), 10)
				: ordered.length;
			const startIdx = Math.max(0, Math.min(fromIdx, ordered.length));
			const sliceStart = Math.max(0, startIdx - limit);
			// Newest-first for dir=b.
			const pageAsc = ordered.slice(sliceStart, startIdx);
			const page = [...pageAsc].reverse();

			// Omit `end` once we have reached the start of the room (index 0),
			// signalling the client to stop paginating.
			result = {
				events: page,
				end: sliceStart > 0 ? `b${sliceStart}` : undefined,
			};
		} else {
			result = await storage.getEventsByRoom(roomId, limit, from, dir);
		}

		let chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);

		if (filter) {
			chunk = chunk.filter((e) => matchesRoomEventFilter(e, filter));
		}

		if (relTypes) {
			chunk = chunk.filter((e) => {
				const rt = relTypeOf(e);
				return rt !== undefined && relTypes.includes(rt);
			});
		}
		if (notRelTypes) {
			chunk = chunk.filter((e) => {
				const rt = relTypeOf(e);
				return rt === undefined || !notRelTypes.includes(rt);
			});
		}

		const ignoredUsers = await getIgnoredUsers(storage, userId);
		if (ignoredUsers.size > 0) {
			chunk = chunk.filter(
				(e) =>
					e.state_key !== undefined ||
					!ignoredUsers.has(e.sender as UserId),
			);
		}

		await bundleAggregations(storage, chunk, userId);

		// Lazy-loading members: when the filter sets `lazy_load_members`, include
		// in `state` the `m.room.member` event for each distinct sender of the
		// returned timeline `chunk` (rather than every member of the room). This
		// lets clients render senders without fetching the full member list.
		let state: ReturnType<typeof pduToClientEvent>[] | undefined;
		if (filter?.lazy_load_members) {
			const seen = new Set<string>();
			const memberEvents: ReturnType<typeof pduToClientEvent>[] = [];
			for (const e of chunk) {
				const sender = e.sender as string;
				if (seen.has(sender)) continue;
				seen.add(sender);
				const entry = await storage.getStateEvent(
					roomId as RoomId,
					"m.room.member",
					sender,
				);
				if (entry) {
					memberEvents.push(
						pduToClientEvent(entry.event, entry.eventId),
					);
				}
			}
			state = memberEvents;
		}

		return {
			status: 200,
			body: {
				start: fromStr ?? "0",
				end: result.end !== undefined ? String(result.end) : undefined,
				chunk,
				...(state !== undefined ? { state } : {}),
			},
		};
	};

export const getMembers =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedOrWorldReadable(storage, roomId, req.userId);

		const membershipFilter = req.query.get("membership");
		const notMembershipFilter = req.query.get("not_membership");
		const atToken = req.query.get("at");

		let entries: { event: PDU; eventId: EventId }[];

		if (atToken !== null) {
			// `?at=<token>` returns room membership as it was at the given point in
			// a sync stream. The token is a stream position (the same integer used
			// for sync `prev_batch`/`next_batch` tokens). We replay every member
			// event in the room up to and including that stream position and keep
			// the latest membership event per user (by state_key).
			const at = parseInt(atToken, 10);
			if (Number.isNaN(at)) throw invalidParam("Invalid 'at' token");

			// `getEventsByRoomSince(roomId, 0, ...)` yields every event in the room
			// in ascending stream order, each annotated with its `streamPos`.
			const all = await storage.getEventsByRoomSince(roomId, 0, 1_000_000);
			const latestByStateKey = new Map<
				string,
				{ event: PDU; eventId: EventId }
			>();
			for (const e of all.events) {
				if (e.streamPos > at) break;
				if (e.event.type !== "m.room.member") continue;
				if (typeof e.event.state_key !== "string") continue;
				latestByStateKey.set(e.event.state_key, {
					event: e.event,
					eventId: e.eventId,
				});
			}
			entries = [...latestByStateKey.values()];
		} else {
			entries = await storage.getMemberEvents(roomId);
		}

		if (membershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>).membership;
				return m === membershipFilter;
			});
		}
		if (notMembershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>).membership;
				return m !== notMembershipFilter;
			});
		}

		const chunk = entries.map((e) => pduToClientEvent(e.event, e.eventId));
		return { status: 200, body: { chunk } };
	};

export const getEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;

		await requireCanReadEventOr404(storage, roomId, req.userId);
		await requireHistoryVisibleOr404(storage, roomId, eventId, req.userId);

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const clientEvent = pduToClientEvent(entry.event, entry.eventId);
		// Strip transaction_id from unsigned if requester is not the sender
		if (
			clientEvent.unsigned &&
			"transaction_id" in clientEvent.unsigned &&
			clientEvent.sender !== req.userId
		) {
			const { transaction_id: _txnId, ...rest } =
				clientEvent.unsigned as Record<string, unknown>;
			clientEvent.unsigned = rest;
		}
		await bundleAggregations(storage, [clientEvent], req.userId ?? "");
		return { status: 200, body: clientEvent };
	};

export const postRedact =
	(
		storage: Storage,
		serverName: string,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const targetEventId = req.params.eventId as string;
		const txnId = req.params.txnId as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		// Room-scoped txn idempotency (see putSendEvent): fold the room into the
		// opaque txn-id string so the storage (user, device, txnId) key is
		// effectively keyed by (user, device, room, txnId).
		const scopedTxnId = `${roomId}${KEY_SEP}${txnId}`;

		const existing = await storage.getTxnEventId(userId, deviceId, scopedTxnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		const room = await requireJoinedRoom(storage, roomId, userId);

		// The target event may not exist locally — e.g. it was authored on a remote
		// server and never federated to us (TestFederationRedactSendsWithoutEvent).
		// In that case we still create, store and fan out the redaction event; we
		// simply skip the local "apply the redaction to the target" step below.
		// Mirrors Synapse, which builds and sends the redaction regardless of
		// whether the redacted event is held locally.
		const targetEntry = await storage.getEvent(targetEventId);
		const targetIsLocal = !!targetEntry && targetEntry.event.room_id === roomId;

		const pl = getPowerLevels(room);
		const senderPl = getUserPowerLevel(userId, room);
		const redactPl = pl.redact ?? 50;
		// We can only enforce the "you may redact your own events at any PL" carve
		// out when the target is held locally (we need its sender). When the target
		// is absent, fall back to the room's redact power level alone.
		if (
			senderPl < redactPl &&
			(!targetIsLocal || targetEntry!.event.sender !== userId)
		) {
			throw forbidden("Insufficient power level to redact");
		}

		const body = (req.body ?? {}) as { reason?: string };
		const content: JsonObject = {};
		if (body.reason) content.reason = body.reason;

		const authEvents = selectAuthEvents(
			"m.room.redaction",
			undefined,
			room,
			userId,
		);
		// Sign the redaction (when a signing key is available) so it can be fanned
		// out to remote servers, which reject unsigned PDUs. Signing is additive and
		// does not change the event ID (computed over the redacted form).
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: "m.room.redaction",
			content,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			redacts: targetEventId,
			serverName,
			signingKey,
			roomVersion: room.room_version,
		});

		checkEventAuth(event, eventId, room);
		await storage.storeEvent(event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		// Apply the redaction to the target only when we actually hold it locally.
		if (targetIsLocal) {
			const redacted = redactEvent(targetEntry!.event);
			redacted.unsigned = {
				...redacted.unsigned,
				redacted_because: pduToClientEvent(event, eventId),
			};
			// Replace the target event content entirely (Object.assign would merge, not strip)
			targetEntry!.event.content = redacted.content;
			targetEntry!.event.unsigned = redacted.unsigned;
			// Persist the redaction so it survives across reads on non-memory backends
			await storage.updateEvent(targetEventId as EventId, targetEntry!.event);
		}

		// Propagate the redaction to remote servers in the room (best-effort).
		if (signingKey && federationClient) {
			await fanoutEvent(
				storage,
				serverName,
				signingKey,
				federationClient,
				roomId as RoomId,
				event,
				eventId,
			);
		}

		await storage.setTxnEventId(userId, deviceId, scopedTxnId, eventId);
		return { status: 200, body: { event_id: eventId } };
	};

export const getContext =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;
		const userId = req.userId ?? "";

		await requireCanReadEventOr404(storage, roomId, req.userId);
		await requireHistoryVisibleOr404(storage, roomId, eventId, req.userId);

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const limit = Math.min(
			Math.max(parseInt(req.query.get("limit") ?? "10", 10), 1),
			100,
		);
		const halfLimit = Math.max(Math.floor(limit / 2), 1);

		const timeline = await storage.getEventsByRoom(
			roomId,
			10000,
			undefined,
			"f",
		);
		const targetIdx = timeline.events.findIndex((e) => e.eventId === eventId);

		let eventsBefore: typeof timeline.events = [];
		let eventsAfter: typeof timeline.events = [];

		if (targetIdx >= 0) {
			eventsBefore = timeline.events
				.slice(Math.max(0, targetIdx - halfLimit), targetIdx)
				.reverse();
			eventsAfter = timeline.events.slice(
				targetIdx + 1,
				targetIdx + 1 + halfLimit,
			);
		}

		const stateEntries = await storage.getAllState(roomId);
		const state = stateEntries.map((e) => pduToClientEvent(e.event, e.eventId));

		const contextEvent = pduToClientEvent(entry.event, entry.eventId);
		const beforeEvents = eventsBefore.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		const afterEvents = eventsAfter.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		await bundleAggregations(
			storage,
			[contextEvent, ...beforeEvents, ...afterEvents],
			userId,
		);

		return {
			status: 200,
			body: {
				event: contextEvent,
				events_before: beforeEvents,
				events_after: afterEvents,
				state,
				start:
					eventsBefore.length > 0
						? String(targetIdx - eventsBefore.length)
						: undefined,
				end:
					eventsAfter.length > 0
						? String(targetIdx + eventsAfter.length + 1)
						: undefined,
			},
		};
	};

export const getJoinedMembers =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const entries = await storage.getMemberEvents(roomId);
		const joined: Record<
			string,
			{ display_name: string | null; avatar_url: string | null }
		> = {};

		for (const entry of entries) {
			const content = entry.event.content as Record<string, unknown>;
			if (content.membership !== "join") continue;
			const userId = entry.event.state_key as string;
			const profile = await storage.getProfile(userId as UserId);
			joined[userId] = {
				display_name: profile?.displayname ?? null,
				avatar_url: profile?.avatar_url ?? null,
			};
		}

		return { status: 200, body: { joined } };
	};

export const getTimestampToEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const tsStr = req.query.get("ts");
		if (!tsStr) throw missingParam("Missing 'ts'");
		const ts = parseInt(tsStr, 10);
		if (Number.isNaN(ts)) throw badJson("'ts' must be a number");

		const dir = req.query.get("dir");
		if (dir !== "f" && dir !== "b") throw badJson("'dir' must be 'f' or 'b'");

		// Events are stored in forward chronological order
		const result = await storage.getEventsByRoom(roomId, 10000, undefined, "f");
		if (result.events.length === 0) throw notFound("No events in room");

		let best: { eventId: string; originServerTs: number } | undefined;

		if (dir === "f") {
			// Find first event at or after ts (events are chronological, first match wins)
			for (const entry of result.events) {
				const eventTs = entry.event.origin_server_ts;
				if (eventTs >= ts) {
					best = { eventId: entry.eventId, originServerTs: eventTs };
					break;
				}
			}
		} else {
			// Find last event at or before ts (scan forward, keep updating)
			for (const entry of result.events) {
				const eventTs = entry.event.origin_server_ts;
				if (eventTs <= ts) {
					best = { eventId: entry.eventId, originServerTs: eventTs };
				} else {
					break;
				}
			}
		}

		if (!best) throw notFound("No event found for the given timestamp");

		return {
			status: 200,
			body: { event_id: best.eventId, origin_server_ts: best.originServerTs },
		};
	};
