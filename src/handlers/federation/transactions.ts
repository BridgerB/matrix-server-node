import {
	checkEventAuth,
	computeContentHash,
	computeEventId,
	makeStateKey,
} from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { FederationClient } from "../../federation/client.ts";
import { verifyOriginSignature } from "../../federation/verify.ts";
import { resolveState } from "../../state-resolution.ts";
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

/** Bounds of an integer representable in canonical JSON (`±(2**53 - 1)`). */
const CANONICALJSON_MAX_INT = 2 ** 53 - 1;
const CANONICALJSON_MIN_INT = -(2 ** 53 - 1);

/**
 * Whether a room version enforces strict canonical JSON (room version 6+).
 * Synapse's `RoomVersion.strict_canonicaljson` is `False` for v1–v5 and `True`
 * from v6 onwards. We parse the leading numeric component of the version string
 * (handling plain "6"/"10" and MSC-style "...mscXXXX.6" suffixes); an
 * unknown/undefined version defaults to the newest (strict) behaviour.
 */
const isStrictCanonicalJson = (roomVersion: string | undefined): boolean => {
	if (!roomVersion) return true; // unknown → newest behaviour (strict)
	const direct = parseInt(roomVersion, 10);
	if (!Number.isNaN(direct)) return direct >= 6;
	const trailing = roomVersion.match(/\.(\d+)$/);
	if (trailing?.[1]) {
		const n = parseInt(trailing[1], 10);
		if (!Number.isNaN(n)) return n >= 6;
	}
	return true;
};

/**
 * Ensure a parsed JSON value obeys the canonical-JSON rules that strict room
 * versions (v6+) enforce: no floats (incl. NaN/Infinity), and integers within
 * `±(2**53 - 1)`. Throws on the first violation.
 *
 * Mirrors Synapse `validate_canonicaljson` (events/utils.py), invoked from
 * `EventValidator.validate_new` when `room_version.strict_canonicaljson` is set.
 * Because our `canonicalJson`/`computeContentHash` happily serialise a float
 * (`JSON.stringify(1.1) === "1.1"`), the bad event's content hash and event ID
 * would otherwise MATCH and the event would verify and be persisted. This guard
 * is what makes us reject such an event instead — without it, a deliberately
 * malformed (float-bearing) event pulled during gap-filling would be stored,
 * poisoning the DAG so a later child appears to have its prev_events present and
 * we'd skip the second /get_missing_events
 * (TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6).
 */
const validateStrictCanonicalJson = (value: unknown): void => {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || !Number.isInteger(value)) {
			throw new Error("Bad JSON value: float");
		}
		if (value < CANONICALJSON_MIN_INT || value > CANONICALJSON_MAX_INT) {
			throw new Error("JSON integer out of range");
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) validateStrictCanonicalJson(item);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			validateStrictCanonicalJson(v);
		}
	}
};

/**
 * Fetch a single event by ID from a remote server via
 * GET /_matrix/federation/v1/event/{eventId}. The response is a federation
 * transaction whose `pdus` array contains the requested event. Returns the PDU
 * (validated: content hash, signature, and event-ID all checked) or null if the
 * remote returns a non-200 (e.g. 404 for a withheld event), the event is
 * missing/malformed, or any validation fails.
 *
 * Mirrors Synapse `FederationClient.get_pdu` + `_check_sigs_and_hash`: a fetched
 * event is only usable once its hash/signature/ID are verified.
 */
const fetchEvent = async (
	storage: Storage,
	eventId: EventId,
	roomId: RoomId,
	origin: ServerName,
	federationClient: FederationClient,
	roomVersion?: string,
): Promise<PDU | null> => {
	let response: { status: number; body: unknown };
	try {
		response = await federationClient.request(
			origin,
			"GET",
			`/_matrix/federation/v1/event/${eventId}`,
		);
	} catch {
		return null;
	}
	if (response.status !== 200) return null;
	const body = (response.body ?? {}) as { pdus?: PDU[] };
	const pdus = Array.isArray(body.pdus) ? body.pdus : [];
	const pdu = pdus.find((p) => {
		try {
			return computeEventId(p, roomVersion) === eventId;
		} catch {
			return false;
		}
	});
	if (!pdu) return null;
	if (pdu.room_id !== roomId) return null;
	// Validate the fetched event the same way we validate inbound PDUs.
	if (pdu.hashes?.sha256 !== computeContentHash(pdu)) return null;
	try {
		await verifyOriginSignature(
			pdu,
			origin,
			storage,
			federationClient,
			roomVersion,
		);
	} catch {
		return null;
	}
	return pdu;
};

/**
 * Resolve a batch of pulled events (state events + auth-chain events fetched via
 * /state_ids → /event) into a set of validated, persisted outliers, returning a
 * map of event_id → PDU for every event that PASSED the state-independent auth
 * rules. Events are processed in auth-dependency order so each event's auth
 * events are decided before the event itself.
 *
 * Rejection rule (Synapse `check_state_independent_auth_rules` rule 2.3 /
 * `_auth_and_persist_outliers`): an event is rejected if ANY event referenced in
 * its `auth_events` is unknown/unfetchable or was itself rejected. We model
 * "rejected" as "absent from the validated set": a rejected event is never added
 * to `validated`, so anything depending on it is rejected in turn. This is what
 * makes a corrupted auth chain (e.g. an unfetchable event B with C→D→E depending
 * on it) propagate rejection up the chain.
 *
 * `available` maps event_id → fetched PDU for every event the remote divulged.
 * Events already in our store are treated as already-validated (they passed auth
 * when we first received them, so they were not rejected).
 *
 * Persistence: validated state events are written via setStateEvent only if they
 * are NOT already known AND they actually belong in the resolved snapshot
 * (handled by the caller); here we only decide accept/reject and return the set.
 * We intentionally do not persist into room state from this function to avoid
 * clobbering current state with a stale snapshot — the caller uses the returned
 * map purely to auth-check the triggering event.
 */
const validateOutliers = async (
	storage: Storage,
	available: Map<EventId, PDU>,
	roomId: RoomId,
): Promise<Map<EventId, PDU>> => {
	const validated = new Map<EventId, PDU>();

	// Seed with events we already have locally (already-accepted, by definition).
	const seenLocally = new Set<EventId>();
	for (const id of available.keys()) {
		const have = await storage.getEvent(id);
		if (have && have.event.room_id === roomId) {
			validated.set(id, have.event);
			seenLocally.add(id);
		}
	}

	// Topologically sort `available` by auth-event dependencies (within the
	// batch) so we decide each event after the events it authenticates against.
	const remaining = new Map<EventId, PDU>();
	for (const [id, pdu] of available) {
		if (!seenLocally.has(id)) remaining.set(id, pdu);
	}

	// Resolve an auth-event id to a known-good PDU: an event we've already
	// validated in this batch, or one already persisted locally (persisted ==
	// previously accepted, since we never store rejected events). Returns null if
	// the event is unknown or in the wrong room (→ treat as rejected/missing).
	const resolveAuthDep = async (authId: EventId): Promise<PDU | null> => {
		const inBatch = validated.get(authId);
		if (inBatch) return inBatch.room_id === roomId ? inBatch : null;
		const local = await storage.getEvent(authId);
		if (local && local.event.room_id === roomId) return local.event;
		return null;
	};

	// Bounded Kahn-style topological pass. Each iteration accepts/rejects every
	// event whose in-batch auth dependencies are already decided; we cap the
	// number of passes at the batch size to guarantee termination even if the
	// remote sends a cycle (a cycle's members simply never become decidable and
	// are dropped = rejected).
	let progressed = true;
	let guard = remaining.size + 1;
	while (progressed && remaining.size > 0 && guard-- > 0) {
		progressed = false;
		for (const [id, pdu] of [...remaining]) {
			// Are all in-batch auth deps decided yet? (deps still pending in the
			// batch must be resolved first, else we can't tell accept from reject.)
			const deps = pdu.auth_events.filter((a) =>
				remaining.has(a as EventId),
			) as EventId[];
			if (deps.length > 0) continue; // wait for deps to be decided

			// Decide this event: every auth_event must resolve to a validated
			// (non-rejected) event in the same room — checking both this batch and
			// our local store — else reject.
			let ok = true;
			for (const authId of pdu.auth_events as EventId[]) {
				const authEvent = await resolveAuthDep(authId);
				if (!authEvent) {
					ok = false;
					break;
				}
			}
			if (ok) validated.set(id, pdu);
			remaining.delete(id);
			progressed = true;
		}
	}

	return validated;
};

/**
 * Walk the `auth_events` DAG of every PDU in `seed` backwards, loading each
 * referenced auth event from `known` (events we already hold in memory) or from
 * local storage, and accumulate every event reached into `out`.
 *
 * Synapse's State Resolution v2.1 conflicted-subgraph walk
 * (`_get_auth_chain_difference` / `resolve_events_with_store`) loads auth events
 * on demand from a `StateResolutionStore` as it descends. Our `resolveState`
 * cannot call back into storage, so we must hand it every event the walk might
 * traverse. The intermediate auth events between two conflicting state events
 * (e.g. an earlier `m.room.power_levels` sitting between the two conflicting
 * ones) are frequently NOT named in the remote's `/state_ids` response — but we
 * usually already hold them locally — so without this pre-loading the subgraph
 * walk dead-ends and v2.1 degrades to v2.0 (state reset).
 *
 * Bounded: each event is expanded at most once; a per-call cap guards against a
 * pathological auth-chain depth.
 */
const gatherAuthChain = async (
	storage: Storage,
	seed: Iterable<PDU>,
	known: Map<EventId, PDU>,
	roomId: RoomId,
	out: Map<EventId, PDU>,
): Promise<void> => {
	const queue: EventId[] = [];
	for (const ev of seed) {
		for (const authId of ev.auth_events as EventId[]) queue.push(authId);
	}
	const seen = new Set<EventId>();
	let guard = 5000; // hard cap on auth-chain traversal per resolution
	while (queue.length > 0 && guard-- > 0) {
		const id = queue.shift() as EventId;
		if (seen.has(id)) continue;
		seen.add(id);
		let ev = out.get(id) ?? known.get(id);
		if (!ev) {
			const local = await storage.getEvent(id);
			if (local && local.event.room_id === roomId) ev = local.event;
		}
		if (!ev || ev.room_id !== roomId) continue;
		out.set(id, ev);
		for (const next of ev.auth_events as EventId[]) {
			if (!seen.has(next)) queue.push(next);
		}
	}
};

/**
 * Resolve the room state at a missing prev_event by asking the origin for a
 * state snapshot, then fetching and validating any events we don't yet have.
 *
 * Mirrors Synapse `_get_state_ids_after_missing_prev_event` +
 * `_resolve_state_at_missing_prevs`:
 *   1. GET /_matrix/federation/v1/state_ids/{roomId}?event_id={prevId}
 *      → { pdu_ids (state at the event), auth_chain_ids }.
 *   2. Fetch every unknown event (state + auth chain) via GET /event.
 *   3. Validate them as outliers, rejecting any whose auth chain references an
 *      unfetchable/rejected event (validateOutliers).
 *   4. Build the state-at-prev map from `pdu_ids`, keeping only validated state
 *      events. If a state event named in `pdu_ids` was rejected (its auth chain
 *      is corrupt) we OMIT it — so a poisoned membership (e.g. the tip of a
 *      corrupted auth chain) does not enter the resolved state.
 *
 * Returns, on success, both:
 *   - `stateMap`: the state-at-prev map (type\x1fstate_key → PDU), built from
 *     `pdu_ids` and keeping only validated state events; and
 *   - `validated`: the FULL set of validated events (state events AND their
 *     auth-chain events), keyed by event id.
 *
 * The caller folds `validated` into the `authEvents` map it passes to
 * `resolveState` so the MSC4297 (State Res v2.1) conflicted-subgraph walk can
 * traverse the auth-chain DAG between conflicted events. Without these
 * auth-chain PDUs the walk dead-ends and the intermediate auth events (e.g. an
 * earlier power-levels event sitting between two conflicting ones) can't be
 * replayed.
 *
 * Returns null if the snapshot could not be obtained. A null result causes the
 * caller to reject the triggering event ("can't get valid state history").
 */
const resolveStateAtMissingPrev = async (
	storage: Storage,
	roomId: RoomId,
	prevId: EventId,
	origin: ServerName,
	federationClient: FederationClient,
	roomVersion?: string,
): Promise<{
	stateMap: Map<string, PDU>;
	validated: Map<EventId, PDU>;
} | null> => {
	let response: { status: number; body: unknown };
	try {
		response = await federationClient.request(
			origin,
			"GET",
			`/_matrix/federation/v1/state_ids/${roomId}?event_id=${prevId}`,
		);
	} catch {
		return null;
	}
	if (response.status !== 200) return null;
	const body = (response.body ?? {}) as {
		pdu_ids?: string[];
		auth_chain_ids?: string[];
	};
	const pduIds = (Array.isArray(body.pdu_ids) ? body.pdu_ids : []) as EventId[];
	const authChainIds = (
		Array.isArray(body.auth_chain_ids) ? body.auth_chain_ids : []
	) as EventId[];

	// Fetch every event we don't already have (state snapshot + auth chain), so
	// we can decide which are valid. Bounded: each id is fetched at most once.
	const available = new Map<EventId, PDU>();
	const toFetch = new Set<EventId>([...pduIds, ...authChainIds]);
	for (const id of toFetch) {
		const have = await storage.getEvent(id);
		if (have) {
			available.set(id, have.event);
			continue;
		}
		const fetched = await fetchEvent(
			storage,
			id,
			roomId,
			origin,
			federationClient,
			roomVersion,
		);
		if (fetched) available.set(id, fetched);
		// If a state/auth event can't be fetched (404) it is simply absent from
		// `available`; validateOutliers then rejects anything depending on it.
	}

	const validated = await validateOutliers(storage, available, roomId);

	// Build the state-at-prev map from pdu_ids, keeping only validated state
	// events. Rejected state events (corrupt auth chain) are omitted.
	const stateMap = new Map<string, PDU>();
	for (const id of pduIds) {
		const ev = validated.get(id);
		if (!ev) continue; // unfetchable or rejected → omit from resolved state
		if (ev.state_key === undefined) continue;
		stateMap.set(makeStateKey(ev.type, ev.state_key), ev);
	}
	// Return the full validated set too (state + auth chain) so the caller can
	// seed the v2.1 conflicted-subgraph walk with the auth-chain events.
	return { stateMap, validated };
};

/**
 * Resolve the auth events of an inbound event into validated PDUs, fetching any
 * we don't have locally from the origin via /event and checking each fetched
 * event's own auth chain. Returns a map of auth-event-id → PDU for every auth
 * event that resolves to a VALID (non-rejected) event in this room, or null if
 * any auth event could not be resolved (unfetchable) — in which case the caller
 * should fall back to current-room-state auth rather than the claimed-auth
 * check.
 *
 * The crucial case (TestInboundFederationRejectsEventsWithRejectedAuthEvents):
 * an inbound event lists an "outlier" among its auth_events that we've never
 * seen. We fetch the outlier; it is valid by its own prev/signatures but its
 * auth chain references a previously-REJECTED event. validateOutliers therefore
 * rejects the outlier, so it is absent from the returned set, and
 * buildAuthEventState below treats the inbound event as having an unresolved
 * auth event and rejects it (Synapse `check_state_independent_auth_rules` 2.3).
 */
const resolveAuthEvents = async (
	storage: Storage,
	pdu: PDU,
	origin: ServerName,
	federationClient: FederationClient,
	roomVersion?: string,
): Promise<Map<EventId, PDU> | null> => {
	const available = new Map<EventId, PDU>();
	for (const authId of pdu.auth_events as EventId[]) {
		const have = await storage.getEvent(authId);
		if (have) {
			available.set(authId, have.event);
			continue;
		}
		// Unknown auth event: fetch it, plus its own auth chain, so we can decide
		// whether it (and thus the inbound event) should be rejected. Bounded by
		// the room's auth-chain depth; each id is fetched at most once.
		const queue: EventId[] = [authId];
		const seen = new Set<EventId>([...available.keys()]);
		let guard = 200; // hard cap on fetches per inbound event (anti-DoS)
		while (queue.length > 0 && guard-- > 0) {
			const id = queue.shift() as EventId;
			if (seen.has(id) || available.has(id)) continue;
			seen.add(id);
			const local = await storage.getEvent(id);
			if (local) {
				available.set(id, local.event);
				continue;
			}
			const fetched = await fetchEvent(
				storage,
				id,
				pdu.room_id,
				origin,
				federationClient,
				roomVersion,
			);
			if (!fetched) continue; // unfetchable → will cause rejection below
			available.set(id, fetched);
			for (const next of fetched.auth_events as EventId[]) {
				if (!seen.has(next)) queue.push(next);
			}
		}
	}

	const validated = await validateOutliers(storage, available, pdu.room_id);

	// Map each of the inbound event's *direct* auth events to its validated PDU.
	// If any is missing from `validated` it was unfetchable or rejected → null.
	const result = new Map<EventId, PDU>();
	for (const authId of pdu.auth_events as EventId[]) {
		const ev = validated.get(authId);
		if (!ev) return null;
		result.set(authId, ev);
	}
	return result;
};

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
 *
 * `origin`/`federationClient`, when supplied, let us fetch auth events we don't
 * have locally (and their auth chains) so we can detect a rejected event hidden
 * in the chain. If a needed auth event resolves to a rejected/unfetchable event,
 * `authChainRejected` is set and the caller MUST reject the inbound event.
 */
const buildAuthEventState = async (
	storage: Storage,
	pdu: PDU,
	room: RoomState,
	origin: ServerName,
	federationClient: FederationClient,
): Promise<{ state: RoomState | null; authChainRejected: boolean }> => {
	const stateEvents = new Map<string, PDU>();

	// First try purely local resolution (fast path, no network).
	let allLocal = true;
	for (const authId of pdu.auth_events) {
		const loaded = await storage.getEvent(authId as EventId);
		if (!loaded) {
			allLocal = false;
			break;
		}
	}

	// If some auth events are missing locally, resolve them over federation. A
	// null result means at least one auth event is unfetchable/rejected → the
	// inbound event must be rejected (auth-chain rule 2.3).
	let resolved: Map<EventId, PDU> | null = null;
	if (!allLocal) {
		resolved = await resolveAuthEvents(
			storage,
			pdu,
			origin,
			federationClient,
			room.room_version,
		);
		if (!resolved) {
			return { state: null, authChainRejected: true };
		}
	}

	for (const authId of pdu.auth_events) {
		const fromResolved = resolved?.get(authId as EventId);
		const loaded = fromResolved
			? { event: fromResolved }
			: await storage.getEvent(authId as EventId);
		// Should not happen (resolved covers the non-local case), but guard.
		if (!loaded) return { state: null, authChainRejected: false };
		const authEvent = loaded.event;
		if (authEvent.room_id !== pdu.room_id) {
			return { state: null, authChainRejected: false };
		}
		if (authEvent.state_key === undefined) {
			return { state: null, authChainRejected: false };
		}
		stateEvents.set(
			makeStateKey(authEvent.type, authEvent.state_key),
			authEvent,
		);
	}

	// In room version 12+ the create event is omitted from auth_events; pull it
	// from the current room state so the auth check still sees it.
	if (!stateEvents.has("m.room.create\x1f")) {
		const create = room.state_events.get("m.room.create\x1f");
		if (create) stateEvents.set("m.room.create\x1f", create);
	}

	return {
		state: {
			room_id: room.room_id,
			room_version: room.room_version,
			state_events: stateEvents,
			depth: room.depth,
			forward_extremities: room.forward_extremities,
		},
		authChainRejected: false,
	};
};

/**
 * Outbound gap-filling. When an inbound PDU references prev_events we don't have
 * locally, ask the origin server to divulge the events between our known
 * forward-extremities and this PDU via POST /get_missing_events, then process
 * those returned events (oldest first) so the gap is filled before we process
 * the PDU itself.
 *
 * Mirrors Synapse `FederationEventHandler._get_missing_events_for_pdu`
 * (synapse/handlers/federation_event.py):
 *   - earliest_events = the events we have already seen (our latest /
 *     forward-extremities); we send these so the remote doesn't re-send what we
 *     already know and so it knows where the overlap is. (Synapse: `latest =
 *     seen | latest_frozen`.)
 *   - latest_events = [the PDU] — the event whose ancestors we want.
 *   - limit = 10, min_depth = 0.
 *   - The returned events are processed oldest-first (by depth), via the same
 *     verification + auth + persist path as a normal inbound PDU (Synapse
 *     `_process_pulled_events`).
 *
 * This deliberately does NOT fall back to /state or /state_ids: if the gap can
 * be filled from /get_missing_events we never need a full state snapshot. If
 * the gap can't be filled, the caller proceeds best-effort against current
 * room state (and the auth-event-state check rejects events whose auth chain we
 * can't reconstruct), which is sufficient for the linear-DAG tests.
 *
 * Recursion guard: we attempt gap-filling exactly once per top-level inbound
 * PDU (`allowGapFill` is false for events pulled in during the fill), so a
 * malicious/looping remote can't drive us into unbounded recursion.
 */
const fetchMissingEvents = async (
	storage: Storage,
	pdu: PDU,
	eventId: EventId,
	origin: ServerName,
	federationClient: FederationClient,
	room: RoomState,
): Promise<void> => {
	// Which prev_events are we missing locally?
	const missingPrevs: EventId[] = [];
	for (const prevId of pdu.prev_events) {
		const have = await storage.getEvent(prevId as EventId);
		if (!have) missingPrevs.push(prevId as EventId);
	}
	if (missingPrevs.length === 0) return;

	// earliest_events: the events we already have (our forward-extremities) so
	// the remote knows where the overlap is and doesn't re-send them.
	const earliestEvents = room.forward_extremities;

	let response: { status: number; body: unknown };
	try {
		response = await federationClient.request(
			origin,
			"POST",
			`/_matrix/federation/v1/get_missing_events/${pdu.room_id}`,
			{
				earliest_events: earliestEvents,
				latest_events: [eventId],
				limit: 10,
				min_depth: 0,
			},
		);
	} catch {
		// Couldn't reach the remote / request failed. Safe to ignore: we still
		// handle the "missing events not returned" case below by proceeding
		// best-effort. (Synapse logs and returns.)
		return;
	}

	if (response.status !== 200) return;
	const body = (response.body ?? {}) as { events?: PDU[] };
	const events = Array.isArray(body.events) ? body.events : [];
	if (events.length === 0) return;

	// Process oldest-first. The remote returns events in reverse-topological
	// (newest-first) order per the spec, but we don't trust that — sort by depth
	// ascending so auth/prev dependencies are satisfied before dependents.
	const sorted = [...events].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

	for (const missing of sorted) {
		let missingId: EventId;
		try {
			missingId = computeEventId(missing, room.room_version);
		} catch {
			continue;
		}
		// Skip ones we somehow already have, and ignore any that belong to a
		// different room than the one we're filling.
		if (missing.room_id !== pdu.room_id) continue;
		const already = await storage.getEvent(missingId);
		if (already) continue;
		try {
			// allowGapFill = false: do not recurse into another /get_missing_events
			// while filling a gap (one attempt per top-level PDU).
			await processPdu(
				storage,
				missing,
				missingId,
				origin,
				federationClient,
				false,
			);
		} catch {
			// A returned event that fails verification/auth (e.g. bad JSON, bad
			// signature, fails auth) is simply dropped — best effort. Synapse
			// `_process_pulled_event` swallows per-event failures.
		}
	}
};

const processPdu = async (
	storage: Storage,
	pdu: PDU,
	eventId: EventId,
	origin: ServerName,
	federationClient: FederationClient,
	allowGapFill = true,
): Promise<void> => {
	const expectedHash = computeContentHash(pdu);
	if (pdu.hashes?.sha256 !== expectedHash) {
		throw new Error("Content hash mismatch");
	}

	// Determine the room version so signature verification and event-ID
	// computation use the correct (version-aware) redaction rules. For a normal
	// event this is the room's stored version; for the room's create event the
	// room may not exist yet, so fall back to the create event's own
	// `content.room_version` (defaulting to "10", our server default).
	const roomForVersion = await storage.getRoom(pdu.room_id);
	const roomVersion =
		roomForVersion?.room_version ??
		(pdu.type === "m.room.create"
			? ((pdu.content as Record<string, unknown>).room_version as
					| string
					| undefined) ?? "10"
			: undefined);

	// Strict canonical-JSON validation (room version 6+). Reject any event whose
	// JSON contains a float or out-of-range integer — our canonicalJson would
	// otherwise serialise a float (e.g. `1.1`) verbatim, so the content hash and
	// event ID would MATCH and the event would verify and persist. Synapse rejects
	// such events up-front (events/validator.py → validate_canonicaljson).
	// Rejecting here keeps a malformed event pulled during gap-filling out of our
	// store, preserving the DAG gap so a later child still triggers
	// /get_missing_events.
	if (isStrictCanonicalJson(roomVersion)) {
		validateStrictCanonicalJson(pdu);
	}

	await verifyOriginSignature(
		pdu,
		origin,
		storage,
		federationClient,
		roomVersion,
	);

	const computedId = computeEventId(pdu, roomVersion);
	if (computedId !== eventId) {
		throw new Error("Event ID mismatch");
	}

	const existing = await storage.getEvent(eventId);
	if (existing) return;

	const room = roomForVersion;
	if (!room) throw new Error("Room not found locally");

	// Server ACL: reject PDUs from a server denied by the room's
	// m.room.server_acl (TestACLs). Synapse checks the ACL per-room at the very
	// top of inbound PDU processing (federation_server.process_pdus_for_room →
	// check_server_matches_acl), BEFORE any gap-filling or state resolution, so a
	// banned server can neither have its events applied to state NOR drive us into
	// outbound /get_missing_events or /state_ids requests on its behalf. We mirror
	// that ordering: drop the event up-front.
	if (!isServerAllowedByAcl(origin, room)) {
		throw new Error("Server denied by ACL");
	}

	// Gap-filling: if this (non-create) event references prev_events we don't
	// have, fetch and process the missing events from the origin first so the
	// DAG is contiguous before we persist this event. Only attempt this for
	// top-level inbound PDUs (allowGapFill) to avoid recursion/loops.
	if (allowGapFill && pdu.type !== "m.room.create") {
		await fetchMissingEvents(
			storage,
			pdu,
			eventId,
			origin,
			federationClient,
			room,
		);
	}

	// State resolution at missing prev_events — ONLY for events PULLED in during
	// gap-filling (allowGapFill === false). Mirroring Synapse's split between
	// `on_receive_pdu` (the top-level pushed event) and `_process_pulled_event`:
	//
	//   - The TOP-LEVEL pushed event (allowGapFill === true) goes through
	//     `on_receive_pdu`. After `_get_missing_events_for_pdu`, if it STILL has
	//     missing prev_events, Synapse does NOT ask for a state snapshot at them —
	//     it rejects the event outright with 403 ("Your server isn't divulging
	//     details about prev_events ...") and uses a plain `compute_event_context`
	//     otherwise. It never issues /state_ids for the top-level event's own
	//     missing prev.
	//
	//   - A PULLED event (allowGapFill === false), processed by
	//     `_process_pulled_event` → `_compute_event_context_with_maybe_missing_prevs`,
	//     is the one that asks the origin for state AT each of ITS missing
	//     prev_events via /state_ids (`_get_state_ids_after_missing_prev_event`),
	//     keyed by the MISSING PREV event id, then resolves the state before the
	//     event from those snapshots.
	//
	// TestCorruptedAuthChain exercises exactly this distinction: hs1 receives
	// `sendTxnEvent` (prev = gmeEvent, missing) via /send. Gap-filling pulls
	// `gmeEvent`, whose own prev `stateIDsEvent` is missing. The /state_ids query
	// that must happen is for `stateIDsEvent` (gmeEvent's missing prev) — issued
	// while processing the PULLED gmeEvent — NOT for `gmeEvent` (sendTxnEvent's own
	// missing prev). Gating this block on allowGapFill === false ensures we only
	// ever issue /state_ids for a pulled event's missing prevs, and that the
	// top-level event is rejected (below) rather than driving a /state_ids on the
	// gap-fill event itself.
	let resolvedStateBefore: RoomState | null = null;
	if (pdu.type !== "m.room.create") {
		const missingPrevs: EventId[] = [];
		for (const prevId of pdu.prev_events) {
			const have = await storage.getEvent(prevId as EventId);
			if (!have) missingPrevs.push(prevId as EventId);
		}

		// Top-level pushed event with still-missing prevs after gap-filling:
		// reject (Synapse `on_receive_pdu` raises FederationError 403). Crucially,
		// we do NOT call /state_ids for the top-level event's missing prev here.
		if (missingPrevs.length > 0 && allowGapFill) {
			throw new Error(
				"Your server isn't divulging details about prev_events",
			);
		}

		if (missingPrevs.length > 0) {
			const stateForks: Map<string, PDU>[] = [];
			// All validated auth-chain events fetched while resolving the missing
			// prevs (via /state_ids → /event). These are NOT part of the fork state
			// maps (which only carry the resolved state-at-prev), but the MSC4297
			// (State Res v2.1) conflicted-subgraph walk in resolveState traverses the
			// auth_events DAG between conflicted events and needs them to be present
			// in the authEvents map, otherwise the walk dead-ends and intermediate
			// auth events can't be replayed.
			const fetchedAuthChain = new Map<EventId, PDU>();
			for (const prevId of missingPrevs) {
				const resolved = await resolveStateAtMissingPrev(
					storage,
					pdu.room_id,
					prevId,
					origin,
					federationClient,
					room.room_version,
				);
				if (!resolved) {
					// Couldn't get valid state at a missing prev → reject this event.
					throw new Error("Cannot resolve state at missing prev_event");
				}
				stateForks.push(resolved.stateMap);
				for (const [id, ev] of resolved.validated) {
					fetchedAuthChain.set(id, ev);
				}
			}

			// Include the state after the prevs we DO know about (approximated by
			// current room state) so the resolution reflects our view of the DAG.
			const ourState = new Map<string, PDU>(room.state_events);
			stateForks.push(ourState);

			// Gather the auth events available to state-res so it can auth-check
			// candidate events AND walk the conflicted subgraph (v2.1). This must
			// include both the fork state events and every validated auth-chain
			// event we fetched while resolving the missing prevs. Bounded by the
			// size of the forks plus the fetched auth chains.
			const authEvents = new Map<EventId, PDU>(fetchedAuthChain);
			for (const fork of stateForks) {
				for (const ev of fork.values()) {
					const id = computeEventId(ev, room.room_version);
					authEvents.set(id, ev);
				}
			}

			// MSC4297 / State Res v2.1: the conflicted-subgraph walk in
			// resolveState descends each candidate's auth_events DAG and needs the
			// intermediate auth events between two conflicting state events to be
			// present. Those are frequently absent from the remote's /state_ids
			// auth_chain (the remote returns the chain it thinks is correct, which
			// is exactly the bit that's wrong) but are usually already in our local
			// store. Pre-load the full transitive auth chain of every fork state
			// event (and the events we fetched) so the walk doesn't dead-end and
			// fall back to v2.0 state-reset behaviour.
			await gatherAuthChain(
				storage,
				[...authEvents.values()],
				authEvents,
				pdu.room_id,
				authEvents,
			);

			const resolvedMap = resolveState(
				stateForks,
				authEvents,
				room,
				room.room_version,
			);
			resolvedStateBefore = {
				room_id: room.room_id,
				room_version: room.room_version,
				state_events: resolvedMap,
				depth: room.depth,
				forward_extremities: room.forward_extremities,
			};
		}
	}

	// The create event is special: it has no prev/auth events to validate
	// against and is authed purely by checkEventAuth below.
	if (pdu.type !== "m.room.create") {
		// Claimed-auth-state check (Synapse check_state_independent +
		// check_state_dependent_auth_rules). Reconstruct the state from the event's
		// auth_events, fetching any we don't have. If any auth event is unfetchable
		// or resolves to a rejected event (corrupt auth chain), the event is
		// rejected outright (auth rule 2.3) — this is the core of
		// TestInboundFederationRejectsEventsWithRejectedAuthEvents.
		const { state: authState, authChainRejected } = await buildAuthEventState(
			storage,
			pdu,
			room,
			origin,
			federationClient,
		);
		if (authChainRejected) {
			throw new Error("Event references a rejected auth event");
		}
		if (authState) {
			checkEventAuth(pdu, eventId, authState);
		}
	}

	// The event must also pass auth against the state before it (Synapse step 5).
	// When we resolved state at missing prev_events use that snapshot; otherwise
	// fall back to current room state (the state as we know it).
	checkEventAuth(pdu, eventId, resolvedStateBefore ?? room);

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
			// Compute the event ID using the room's version (or the create event's
			// own room_version) so it matches the version-aware ID computed inside
			// processPdu — otherwise the result key and the internal ID-match check
			// would disagree for v1–v10 rooms.
			const roomForVersion = await storage.getRoom(pdu.room_id);
			const eventIdRoomVersion =
				roomForVersion?.room_version ??
				(pdu.type === "m.room.create"
					? ((pdu.content as Record<string, unknown>).room_version as
							| string
							| undefined) ?? "10"
					: undefined);
			const eventId = computeEventId(pdu, eventIdRoomVersion);
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
