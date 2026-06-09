import {
	checkEventAuth,
	computeEventId,
	getUserPowerLevel,
	isRoomVersion12Plus,
	makeStateKey,
} from "./events.ts";
import type { PDU } from "./types/events.ts";
import type { EventId } from "./types/index.ts";
import type { RoomState } from "./types/internal.ts";

const POWER_EVENT_TYPES = new Set([
	"m.room.power_levels",
	"m.room.join_rules",
	"m.room.member",
	"m.room.third_party_invite",
]);

/**
 * Sort events by reverse topological power ordering:
 * 1. Sender power level (descending)
 * 2. origin_server_ts (ascending)
 * 3. Event ID lexicographic (ascending)
 */
const reverseTopologicalPowerOrder = (
	events: PDU[],
	_authEvents: Map<EventId, PDU>,
	roomState: RoomState,
): PDU[] =>
	[...events].sort((a, b) => {
		const plA = getUserPowerLevel(a.sender, roomState);
		const plB = getUserPowerLevel(b.sender, roomState);
		if (plA !== plB) return plB - plA;

		if (a.origin_server_ts !== b.origin_server_ts) {
			return a.origin_server_ts - b.origin_server_ts;
		}

		const idA = computeEventId(a, roomState.room_version);
		const idB = computeEventId(b, roomState.room_version);
		return idA < idB ? -1 : idA > idB ? 1 : 0;
	});

/**
 * Apply a sorted list of candidate events on top of `resolvedState`, keeping
 * each event only if it passes auth checks.
 *
 * For State Resolution v2.1 (`useAuthEventBase`) the auth check for an event is
 * performed against a base built from the event's OWN `auth_events` (resolved
 * via `authEventMap`), with the current `resolvedState` overlaid on top for any
 * matching state tuples. This mirrors Synapse's `_iterative_auth_checks`, which
 * populates the per-event auth context from `event.auth_event_ids()` first and
 * then overrides with the running resolved state. This is what makes the v2.1
 * "start from the empty set" behaviour safe: a replayed event is checked against
 * the auth events it actually cited rather than against a possibly-bogus
 * unconflicted base state.
 *
 * For v2.0 (`useAuthEventBase` false) the historical behaviour is preserved: the
 * event is checked directly against `resolvedState`.
 */
const applyEvents = (
	events: PDU[],
	roomState: RoomState,
	resolvedState: Map<string, PDU>,
	authEventMap: Map<EventId, PDU>,
	useAuthEventBase: boolean,
	createEvent: PDU | undefined,
): void => {
	for (const event of events) {
		const key = makeStateKey(event.type, event.state_key ?? "");

		// Build the state the candidate is auth-checked against.
		const base = new Map<string, PDU>();
		if (useAuthEventBase) {
			// The create event is always unconflicted and is required for the v12+
			// creator power-level / auth rules; it is NOT listed in auth_events in
			// v12+, so seed it explicitly when known.
			if (createEvent) base.set("m.room.create\x1f", createEvent);
			// Seed from the event's own auth_events (Synapse IAC behaviour).
			for (const authId of event.auth_events as EventId[]) {
				const authEvent = authEventMap.get(authId);
				if (!authEvent || authEvent.state_key === undefined) continue;
				base.set(makeStateKey(authEvent.type, authEvent.state_key), authEvent);
			}
			// The running resolved state takes priority over auth_events.
			for (const [k, v] of resolvedState) base.set(k, v);
		} else {
			for (const [k, v] of resolvedState) base.set(k, v);
		}

		const testState: RoomState = {
			...roomState,
			state_events: base,
		};
		try {
			const eventId = computeEventId(event, roomState.room_version);
			checkEventAuth(event, eventId, testState);
			resolvedState.set(key, event);
		} catch {}
	}
};

/**
 * Compute the conflicted subgraph (MSC4297 / State Resolution v2.1).
 *
 * Given the set of directly-conflicted event IDs, walk the auth-chain DAG and
 * collect every event that lies on a path between two conflicted events (i.e.
 * the full subgraph of conflicted events down to a common ancestor). These extra
 * events become additional candidates for the iterative auth-check phase so that
 * intermediate auth events (e.g. a power-level event that sits between two
 * conflicting power-level events) are replayed too, rather than being silently
 * dropped — which in v2.0 could cause a state reset.
 *
 * This mirrors the depth-first walk in Synapse's `_get_auth_chain_difference`
 * (v2.1 path) and tuwunel's `conflicted_subgraph_dfs`: starting from each
 * conflicted event, descend through `auth_events`; whenever a path reaches
 * another conflicted event (or an event already known to be in the subgraph),
 * every event along that path is added to the subgraph.
 *
 * Only events available in `authEventMap` can be traversed; unknown auth events
 * terminate that branch of the walk.
 */
const computeConflictedSubgraph = (
	conflictedIds: Set<EventId>,
	authEventMap: Map<EventId, PDU>,
): Set<EventId> => {
	const subgraph = new Set<EventId>();

	// A DFS frame: the event being visited, and the list of its auth_events still
	// to descend into. The frame's `eventId`s, read off the stack bottom-to-top,
	// form the current DFS path.
	interface Frame {
		eventId: EventId;
		remaining: EventId[];
	}

	// Events already fully descended into across all starts. Once an event has
	// been expanded we never descend into it again (bounding work to O(edges));
	// the `subgraph.has(childId)` check below still extends the current path
	// through it, so its connectivity is not lost. Mirrors tuwunel's `seen`.
	const expanded = new Set<EventId>();

	for (const start of conflictedIds) {
		const startEvent = authEventMap.get(start);
		const stack: Frame[] = [
			{
				eventId: start,
				remaining: startEvent
					? [...(startEvent.auth_events as EventId[])]
					: [],
			},
		];

		while (stack.length > 0) {
			const frame = stack[stack.length - 1] as Frame;
			if (frame.remaining.length === 0) {
				stack.pop();
				continue;
			}
			const childId = frame.remaining.pop() as EventId;

			// Reaching another conflicted event, or an event already known to be in
			// the subgraph, means every event on the current path (start .. child)
			// lies between two conflicted events and is part of the subgraph.
			const connects =
				conflictedIds.has(childId) || subgraph.has(childId);
			if (connects) {
				for (const f of stack) subgraph.add(f.eventId);
				subgraph.add(childId);
				continue;
			}

			// Don't re-descend into an event already expanded (also guards cycles).
			if (expanded.has(childId)) continue;
			expanded.add(childId);

			const childEvent = authEventMap.get(childId);
			if (!childEvent) continue; // unknown/unfetchable: terminate this branch.
			stack.push({
				eventId: childId,
				remaining: [...(childEvent.auth_events as EventId[])],
			});
		}
	}

	return subgraph;
};

/**
 * Resolve conflicting state from multiple forks.
 *
 * State Resolution v2.0 (room versions 2-11): iterative auth checks start
 * with the unconflicted state map, and each candidate is auth-checked directly
 * against the running resolved state.
 *
 * State Resolution v2.1 (room version 12+, MSC4297): two changes are made:
 *   1. "Includes the conflicted subgraph": in addition to the directly
 *      conflicted state events, the full auth-chain subgraph between conflicted
 *      events (down to a common ancestor) is included as candidates for the
 *      iterative auth-check phase.
 *   2. "Starts from the empty set": the iterative auth-check phase begins from
 *      an empty map rather than the unconflicted state. Each candidate is
 *      auth-checked against a base built from its OWN `auth_events` (with the
 *      running resolved state layered on top), and the unconflicted state is
 *      re-applied unconditionally at the very end.
 *
 * @param stateAtForks - Array of state maps, one per fork
 * @param authEvents - Map of all available auth events (event id -> PDU)
 * @param roomState - The base room state for auth checking
 * @param roomVersion - The room version string (determines v2.0 vs v2.1)
 * @returns Resolved state map
 */
export const resolveState = (
	stateAtForks: Map<string, PDU>[],
	authEvents: Map<EventId, PDU>,
	roomState: RoomState,
	roomVersion?: string,
): Map<string, PDU> => {
	if (stateAtForks.length === 0) return new Map();
	if (stateAtForks.length === 1)
		return new Map(stateAtForks[0] as Map<string, PDU>);

	const useV21 = isRoomVersion12Plus(roomVersion);

	const allKeys = new Set<string>();
	for (const stateMap of stateAtForks) {
		for (const key of stateMap.keys()) allKeys.add(key);
	}

	const unconflicted = new Map<string, PDU>();
	const conflictedPower: PDU[] = [];
	const conflictedOther: PDU[] = [];
	// Event ids of every directly-conflicted state event (used to seed the
	// conflicted subgraph walk for v2.1).
	const conflictedIds = new Set<EventId>();

	for (const key of allKeys) {
		const events: PDU[] = [];
		const eventIds = new Set<string>();

		for (const stateMap of stateAtForks) {
			const event = stateMap.get(key);
			if (event) {
				const eventId = computeEventId(event, roomVersion);
				if (!eventIds.has(eventId)) {
					events.push(event);
					eventIds.add(eventId);
				}
			}
		}

		if (events.length === 1) {
			unconflicted.set(key, events[0] as PDU);
		} else if (events.length > 1) {
			for (const ev of events) conflictedIds.add(computeEventId(ev, roomVersion));
			const eventType = key.split("\x1f")[0] as string;
			if (POWER_EVENT_TYPES.has(eventType)) {
				conflictedPower.push(...events);
			} else {
				conflictedOther.push(...events);
			}
		}
	}

	// MSC4297: expand the candidate set with the conflicted subgraph. Any
	// subgraph event we can resolve to a PDU and that is not already a directly
	// conflicted candidate becomes an extra candidate, partitioned into
	// power/other just like the directly conflicted events.
	if (useV21) {
		const subgraph = computeConflictedSubgraph(conflictedIds, authEvents);
		for (const id of subgraph) {
			if (conflictedIds.has(id)) continue;
			const ev = authEvents.get(id);
			if (!ev || ev.state_key === undefined) continue;
			conflictedIds.add(id);
			if (POWER_EVENT_TYPES.has(ev.type)) {
				conflictedPower.push(ev);
			} else {
				conflictedOther.push(ev);
			}
		}
	}

	const sortedPower = reverseTopologicalPowerOrder(
		conflictedPower,
		authEvents,
		roomState,
	);

	// The create event is always unconflicted (it is the room's first event and
	// identical across forks). It is needed in the v2.1 auth base because in v12+
	// it is not present in any event's auth_events.
	const createEvent = unconflicted.get("m.room.create\x1f");

	// v2.0: start with unconflicted state; v2.1: start with empty map.
	const resolvedState = useV21 ? new Map<string, PDU>() : new Map(unconflicted);
	applyEvents(
		sortedPower,
		roomState,
		resolvedState,
		authEvents,
		useV21,
		createEvent,
	);

	const sortedOther = reverseTopologicalPowerOrder(
		conflictedOther,
		authEvents,
		roomState,
	);
	applyEvents(
		sortedOther,
		roomState,
		resolvedState,
		authEvents,
		useV21,
		createEvent,
	);

	// v2.1: the unconflicted state always still applies. It is layered on top of
	// the resolved conflicts with no further auth checks (mirroring Synapse's
	// final `resolved_state.update(unconflicted_state)`).
	if (useV21) {
		for (const [key, event] of unconflicted) {
			resolvedState.set(key, event);
		}
	}

	return resolvedState;
};
