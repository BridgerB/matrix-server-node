import {
	CREATOR_POWER_LEVEL,
	checkEventAuth,
	computeEventId,
	isRoomVersion12Plus,
	makeStateKey,
} from "./events.ts";
import type { PDU } from "./types/events.ts";
import type { EventId } from "./types/index.ts";
import type { RoomState } from "./types/internal.ts";

const CREATE_KEY = makeStateKey("m.room.create", "");
const POWER_LEVELS_KEY = makeStateKey("m.room.power_levels", "");

/**
 * Whether an event is a "power event" as defined by State Resolution v2
 * (Synapse `_is_power_event`):
 *   - m.room.power_levels (state_key "")
 *   - m.room.join_rules (state_key "")
 *   - m.room.create (state_key "")
 *   - m.room.member where membership is leave/ban AND sender != state_key
 *     (i.e. a kick or a ban of another user).
 */
const isPowerEvent = (event: PDU): boolean => {
	if (event.state_key === "") {
		if (
			event.type === "m.room.power_levels" ||
			event.type === "m.room.join_rules" ||
			event.type === "m.room.create"
		) {
			return true;
		}
	}
	if (event.type === "m.room.member") {
		const membership = (event.content as Record<string, unknown>)
			.membership as string | undefined;
		if (membership === "leave" || membership === "ban") {
			return event.sender !== event.state_key;
		}
	}
	return false;
};

/**
 * Power level of an event's sender, computed from the event's OWN `auth_events`
 * (Synapse `_get_power_level_for_sender`), NOT from the running resolved state.
 *
 * This is the crux of correct v2 power ordering: each candidate is ranked by the
 * authority its sender had at the point the event was created (per its auth
 * events), so e.g. two competing power-level events are ordered by the PL of the
 * users who issued them, taken from the PL in effect when each was sent.
 *
 *   1. Find the m.room.power_levels and m.room.create referenced in auth_events.
 *   2. v12+ (MSC4289): the room creator (create.sender / additional_creators)
 *      holds CREATOR_POWER_LEVEL.
 *   3. Otherwise use the PL event's `users[sender]`, falling back to
 *      `users_default`.
 *   4. With no PL event, the create event's creator has implicit PL 100, else 0.
 */
const getPowerLevelForSender = (
	event: PDU,
	authEventMap: Map<EventId, PDU>,
	roomVersion: string | undefined,
	createEvent: PDU | undefined,
): number => {
	let plEvent: PDU | undefined;
	let create: PDU | undefined = createEvent;
	for (const aid of event.auth_events as EventId[]) {
		const aev = authEventMap.get(aid);
		if (!aev) continue;
		if (aev.type === "m.room.power_levels" && aev.state_key === "") {
			plEvent = aev;
		}
		if (aev.type === "m.room.create" && aev.state_key === "") {
			create = aev;
		}
	}

	// v12+: room creators hold an implicit infinite power level (MSC4289).
	if (isRoomVersion12Plus(roomVersion) && create) {
		const createContent = create.content as Record<string, unknown>;
		const additionalCreators =
			(createContent.additional_creators as string[] | undefined) ?? [];
		if (
			create.sender === event.sender ||
			additionalCreators.includes(event.sender)
		) {
			return CREATOR_POWER_LEVEL;
		}
	}

	if (!plEvent) {
		// No power-level event in the auth chain: the room creator has implicit
		// PL 100, everyone else 0.
		if (create && create.sender === event.sender) return 100;
		return 0;
	}

	const content = plEvent.content as Record<string, unknown>;
	const users = (content.users as Record<string, number> | undefined) ?? {};
	const level = users[event.sender];
	if (level !== undefined) return level;
	const usersDefault = content.users_default as number | undefined;
	return usersDefault ?? 0;
};

/**
 * Build the auth-chain subgraph restricted to events that are themselves in the
 * `conflictedSet`. The returned map is `event_id -> set of its auth_events that
 * are also in the conflicted set` — i.e. the out-edges used by the
 * lexicographical topological sort.
 *
 * Mirrors Synapse `_add_event_and_auth_chain_to_graph`: starting from each
 * event, descend `auth_events`; an auth event is added as an out-edge only if it
 * lies in `fullConflictedSet`. Every reachable in-set auth event is itself added
 * to the graph so the sort sees the full dependency chain.
 */
const buildPowerGraph = (
	eventIds: EventId[],
	authEventMap: Map<EventId, PDU>,
	fullConflictedSet: Set<EventId>,
): Map<EventId, Set<EventId>> => {
	const graph = new Map<EventId, Set<EventId>>();
	for (const startId of eventIds) {
		const stack: EventId[] = [startId];
		while (stack.length > 0) {
			const eid = stack.pop() as EventId;
			if (!graph.has(eid)) graph.set(eid, new Set());
			const event = authEventMap.get(eid);
			if (!event) continue;
			for (const aid of event.auth_events as EventId[]) {
				if (fullConflictedSet.has(aid)) {
					if (!graph.has(aid)) stack.push(aid);
					graph.get(eid)?.add(aid);
				}
			}
		}
	}
	return graph;
};

/**
 * Lexicographical reverse-topological sort (Synapse `lexicographical_topological_sort`
 * + `_reverse_topological_power_sort`).
 *
 * Kahn's algorithm over the auth-chain `graph` (out-edges = an event's
 * auth_events that are in the conflicted set). Nodes with zero out-degree (their
 * in-conflict dependencies already emitted) are emitted first, so a dependency
 * always precedes its dependents. Ties between independent nodes are broken by
 * `(-power_level, origin_server_ts, event_id)`.
 *
 * This is what makes the iterative auth-check phase apply chained power-level
 * events in auth-chain order regardless of their timestamps — without it, a
 * later-in-the-chain event with an earlier `origin_server_ts` could be applied
 * first and then overwritten by its own (now stale) ancestor.
 */
const reverseTopologicalPowerSort = (
	eventIds: EventId[],
	authEventMap: Map<EventId, PDU>,
	fullConflictedSet: Set<EventId>,
	roomVersion: string | undefined,
	createEvent: PDU | undefined,
): EventId[] => {
	const graph = buildPowerGraph(eventIds, authEventMap, fullConflictedSet);

	// Power level per node, from each event's own auth_events.
	const powerLevel = new Map<EventId, number>();
	for (const id of graph.keys()) {
		const ev = authEventMap.get(id);
		powerLevel.set(
			id,
			ev ? getPowerLevelForSender(ev, authEventMap, roomVersion, createEvent) : 0,
		);
	}

	// Tie-break ordering: lower is emitted first → (-pl, ts, id) ascending.
	const less = (a: EventId, b: EventId): boolean => {
		const plA = powerLevel.get(a) ?? 0;
		const plB = powerLevel.get(b) ?? 0;
		if (plA !== plB) return plA > plB; // higher PL sorts first
		const evA = authEventMap.get(a);
		const evB = authEventMap.get(b);
		const tsA = evA?.origin_server_ts ?? 0;
		const tsB = evB?.origin_server_ts ?? 0;
		if (tsA !== tsB) return tsA < tsB;
		return a < b;
	};

	// reverse_graph[node] = nodes that reference `node` as an out-edge (parents).
	const reverseGraph = new Map<EventId, Set<EventId>>();
	const outdegree = new Map<EventId, Set<EventId>>();
	for (const [node, edges] of graph) {
		if (!reverseGraph.has(node)) reverseGraph.set(node, new Set());
		outdegree.set(node, new Set(edges));
		for (const edge of edges) {
			if (!reverseGraph.has(edge)) reverseGraph.set(edge, new Set());
			reverseGraph.get(edge)?.add(node);
		}
	}

	// A simple sorted-array priority queue keyed by `less`.
	const queue: EventId[] = [];
	const enqueue = (id: EventId): void => {
		let lo = 0;
		let hi = queue.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (less(queue[mid] as EventId, id)) lo = mid + 1;
			else hi = mid;
		}
		queue.splice(lo, 0, id);
	};

	for (const [node, edges] of outdegree) {
		if (edges.size === 0) enqueue(node);
	}

	const sorted: EventId[] = [];
	while (queue.length > 0) {
		const node = queue.shift() as EventId;
		sorted.push(node);
		for (const parent of reverseGraph.get(node) ?? []) {
			const out = outdegree.get(parent);
			if (!out) continue;
			out.delete(node);
			if (out.size === 0) enqueue(parent);
		}
	}

	return sorted;
};

/**
 * Mainline ordering for the non-power "leftover" events (Synapse `_mainline_sort`).
 *
 * The mainline is the chain of power-level events reachable by following the
 * resolved power-level event's `auth_events` back to the root. Each leftover
 * event is assigned the mainline depth of the closest power-level event in its
 * own auth chain, then sorted by `(mainline_depth, origin_server_ts, event_id)`.
 */
const mainlineSort = (
	eventIds: EventId[],
	resolvedPowerLevelId: EventId | undefined,
	authEventMap: Map<EventId, PDU>,
	idFor: (ev: PDU) => EventId,
): EventId[] => {
	if (eventIds.length === 0) return [];

	// Build the mainline: resolved PL → its PL ancestor → ... → root.
	const mainline: EventId[] = [];
	let plId: EventId | undefined = resolvedPowerLevelId;
	const guardSeen = new Set<EventId>();
	while (plId && !guardSeen.has(plId)) {
		guardSeen.add(plId);
		mainline.push(plId);
		const plEv = authEventMap.get(plId);
		plId = undefined;
		if (plEv) {
			for (const aid of plEv.auth_events as EventId[]) {
				const aev = authEventMap.get(aid);
				if (aev && aev.type === "m.room.power_levels" && aev.state_key === "") {
					plId = aid;
					break;
				}
			}
		}
	}

	// mainline_map: event_id → depth (1-based from the root end).
	const mainlineMap = new Map<EventId, number>();
	const reversed = [...mainline].reverse();
	reversed.forEach((id, i) => mainlineMap.set(id, i + 1));

	const mainlineDepth = (event: PDU): number => {
		let tmp: PDU | undefined = event;
		const seen = new Set<EventId>();
		while (tmp) {
			const id = idFor(tmp);
			const depth = mainlineMap.get(id);
			if (depth !== undefined) return depth;
			if (seen.has(id)) break;
			seen.add(id);
			let next: PDU | undefined;
			for (const aid of tmp.auth_events as EventId[]) {
				const aev = authEventMap.get(aid);
				if (aev && aev.type === "m.room.power_levels" && aev.state_key === "") {
					next = aev;
					break;
				}
			}
			tmp = next;
		}
		return 0;
	};

	const order = new Map<EventId, [number, number, EventId]>();
	for (const id of eventIds) {
		const ev = authEventMap.get(id);
		order.set(id, [
			ev ? mainlineDepth(ev) : 0,
			ev?.origin_server_ts ?? 0,
			id,
		]);
	}

	return [...eventIds].sort((a, b) => {
		const oa = order.get(a) as [number, number, EventId];
		const ob = order.get(b) as [number, number, EventId];
		if (oa[0] !== ob[0]) return oa[0] - ob[0];
		if (oa[1] !== ob[1]) return oa[1] - ob[1];
		return oa[2] < ob[2] ? -1 : oa[2] > ob[2] ? 1 : 0;
	});
};

/**
 * Apply a sorted list of candidate events on top of `resolvedState`, keeping
 * each event only if it passes auth checks (Synapse `_iterative_auth_checks`).
 *
 * The auth check for an event is performed against a base built from the event's
 * OWN `auth_events` (resolved via `authEventMap`), with the current
 * `resolvedState` overlaid on top for any state tuple the event's auth rules
 * actually consult. This makes the v2.1 "start from the empty set" behaviour
 * safe: a replayed event is checked against the auth events it cited rather than
 * against a possibly-bogus unconflicted base. For v2.0 (`useAuthEventBase`
 * false) the event is checked directly against `resolvedState`.
 */
const applyEvents = (
	eventIds: EventId[],
	roomState: RoomState,
	resolvedState: Map<string, PDU>,
	authEventMap: Map<EventId, PDU>,
	useAuthEventBase: boolean,
	createEvent: PDU | undefined,
	roomVersion: string | undefined,
): void => {
	for (const eventId of eventIds) {
		const event = authEventMap.get(eventId);
		if (!event || event.state_key === undefined) continue;
		const key = makeStateKey(event.type, event.state_key);

		const base = new Map<string, PDU>();
		if (useAuthEventBase) {
			// The create event is always unconflicted and is required for the v12+
			// creator power-level / auth rules; it is NOT listed in auth_events in
			// v12+, so seed it explicitly when known.
			if (createEvent) base.set(CREATE_KEY, createEvent);
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

		const testState: RoomState = { ...roomState, state_events: base };
		try {
			const id = computeEventId(event, roomVersion);
			checkEventAuth(event, id, testState);
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
 * Mirrors Synapse's v2.1 conflicted-subgraph computation: starting from each
 * conflicted event, descend through `auth_events`; whenever a path reaches
 * another conflicted event (or an event already known to be in the subgraph),
 * every event along that path is added to the subgraph. Only events available in
 * `authEventMap` can be traversed; unknown auth events terminate that branch.
 */
const computeConflictedSubgraph = (
	conflictedIds: Set<EventId>,
	authEventMap: Map<EventId, PDU>,
): Set<EventId> => {
	const subgraph = new Set<EventId>();

	interface Frame {
		eventId: EventId;
		remaining: EventId[];
	}

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

			const connects = conflictedIds.has(childId) || subgraph.has(childId);
			if (connects) {
				for (const f of stack) subgraph.add(f.eventId);
				subgraph.add(childId);
				continue;
			}

			if (expanded.has(childId)) continue;
			expanded.add(childId);

			const childEvent = authEventMap.get(childId);
			if (!childEvent) continue;
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
 * State Resolution v2.0 (room versions 2-11): the iterative auth-check phase
 * starts with the unconflicted state map; conflicted power events are sorted by
 * reverse-topological power ordering, the leftover events by mainline ordering.
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
 * A state key is treated as conflicted if the forks disagree on it OR some fork
 * is missing it (Synapse `_seperate`).
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

	// Index every fork event by id so the iterative phase / sorts can resolve
	// candidate ids back to PDUs even if they aren't in `authEvents`.
	const eventMap = new Map<EventId, PDU>(authEvents);
	const idCache = new Map<PDU, EventId>();
	const idFor = (ev: PDU): EventId => {
		let id = idCache.get(ev);
		if (id === undefined) {
			id = computeEventId(ev, roomVersion);
			idCache.set(ev, id);
		}
		return id;
	};
	for (const fork of stateAtForks) {
		for (const ev of fork.values()) {
			const id = idFor(ev);
			if (!eventMap.has(id)) eventMap.set(id, ev);
		}
	}

	const allKeys = new Set<string>();
	for (const stateMap of stateAtForks) {
		for (const key of stateMap.keys()) allKeys.add(key);
	}

	const unconflicted = new Map<string, PDU>();
	// Directly-conflicted state-event ids (used to seed the v2.1 subgraph walk).
	const conflictedIds = new Set<EventId>();
	// All conflicted candidate ids (directly conflicted + v2.1 subgraph).
	const fullConflictedSet = new Set<EventId>();

	for (const key of allKeys) {
		// A key is conflicted if any fork is missing it, or the forks disagree
		// (Synapse `_seperate`).
		const ids = new Set<EventId | null>();
		const byId = new Map<EventId, PDU>();
		for (const stateMap of stateAtForks) {
			const ev = stateMap.get(key);
			if (ev) {
				const id = idFor(ev);
				ids.add(id);
				byId.set(id, ev);
			} else {
				ids.add(null);
			}
		}

		if (ids.size === 1) {
			// All forks agree on the same event (no nulls).
			const only = byId.values().next().value as PDU | undefined;
			if (only) unconflicted.set(key, only);
		} else {
			for (const [id] of byId) {
				conflictedIds.add(id);
				fullConflictedSet.add(id);
			}
		}
	}

	// MSC4297: expand the candidate set with the conflicted subgraph.
	if (useV21 && conflictedIds.size > 0) {
		const subgraph = computeConflictedSubgraph(conflictedIds, eventMap);
		for (const id of subgraph) fullConflictedSet.add(id);
	}

	// The create event is always unconflicted (the room's first event, identical
	// across forks). It is needed in the v2.1 auth base because in v12+ it is not
	// present in any event's auth_events.
	const createEvent = unconflicted.get(CREATE_KEY);

	// Partition the full conflicted set into power events and the rest.
	const powerEventIds: EventId[] = [];
	const otherEventIds: EventId[] = [];
	for (const id of fullConflictedSet) {
		const ev = eventMap.get(id);
		// Only genuine state events can be placed back into the resolved map.
		if (!ev || ev.state_key === undefined) continue;
		// Power events (PL, join_rules, create, kicks/bans) are sorted by reverse
		// topological power ordering; everything else by mainline ordering. Note
		// this differs from the v2 "power event" key set: a plain self-join member
		// event is a leftover (mainline) event, not a power event.
		if (isPowerEvent(ev)) powerEventIds.push(id);
		else otherEventIds.push(id);
	}

	const sortedPower = reverseTopologicalPowerSort(
		powerEventIds,
		eventMap,
		fullConflictedSet,
		roomVersion,
		createEvent,
	);

	// v2.0: start with unconflicted state; v2.1: start with empty map.
	const resolvedState = useV21
		? new Map<string, PDU>()
		: new Map(unconflicted);

	applyEvents(
		sortedPower,
		roomState,
		resolvedState,
		eventMap,
		useV21,
		createEvent,
		roomVersion,
	);

	// Leftover (non-power) events are ordered by mainline of the resolved PL.
	const resolvedPl = resolvedState.get(POWER_LEVELS_KEY);
	const resolvedPlId = resolvedPl ? idFor(resolvedPl) : undefined;
	const sortedOther = mainlineSort(
		otherEventIds,
		resolvedPlId,
		eventMap,
		idFor,
	);

	applyEvents(
		sortedOther,
		roomState,
		resolvedState,
		eventMap,
		useV21,
		createEvent,
		roomVersion,
	);

	// Unconflicted state always still applies, layered on top of the resolved
	// conflicts with no further auth checks (Synapse final
	// `resolved_state.update(unconflicted_state)`). For v2.0 it was the base, so
	// re-applying is harmless; for v2.1 it is required.
	for (const [key, event] of unconflicted) {
		resolvedState.set(key, event);
	}

	return resolvedState;
};
