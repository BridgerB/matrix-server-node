import {
	checkEventAuth,
	computeEventId,
	getUserPowerLevel,
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

		const idA = computeEventId(a);
		const idB = computeEventId(b);
		return idA < idB ? -1 : idA > idB ? 1 : 0;
	});

const applyEvents = (
	events: PDU[],
	roomState: RoomState,
	resolvedState: Map<string, PDU>,
): void => {
	for (const event of events) {
		const key = makeStateKey(event.type, event.state_key ?? "");
		const testState: RoomState = {
			...roomState,
			state_events: new Map(resolvedState),
		};
		try {
			const eventId = computeEventId(event);
			checkEventAuth(event, eventId, testState);
			resolvedState.set(key, event);
		} catch {}
	}
};

/**
 * Resolve conflicting state from multiple forks.
 *
 * @param stateAtForks - Array of state maps, one per fork
 * @param authEvents - Map of all available auth events
 * @param roomState - The base room state for auth checking
 * @returns Resolved state map
 */
export const resolveState = (
	stateAtForks: Map<string, PDU>[],
	authEvents: Map<EventId, PDU>,
	roomState: RoomState,
): Map<string, PDU> => {
	if (stateAtForks.length === 0) return new Map();
	if (stateAtForks.length === 1)
		return new Map(stateAtForks[0] as Map<string, PDU>);

	const allKeys = new Set<string>();
	for (const stateMap of stateAtForks) {
		for (const key of stateMap.keys()) allKeys.add(key);
	}

	const unconflicted = new Map<string, PDU>();
	const conflictedPower: PDU[] = [];
	const conflictedOther: PDU[] = [];

	for (const key of allKeys) {
		const events: PDU[] = [];
		const eventIds = new Set<string>();

		for (const stateMap of stateAtForks) {
			const event = stateMap.get(key);
			if (event) {
				const eventId = computeEventId(event);
				if (!eventIds.has(eventId)) {
					events.push(event);
					eventIds.add(eventId);
				}
			}
		}

		if (events.length === 1) {
			unconflicted.set(key, events[0] as PDU);
		} else if (events.length > 1) {
			const eventType = key.split("\0")[0] as string;
			if (POWER_EVENT_TYPES.has(eventType)) {
				conflictedPower.push(...events);
			} else {
				conflictedOther.push(...events);
			}
		}
	}

	const sortedPower = reverseTopologicalPowerOrder(
		conflictedPower,
		authEvents,
		roomState,
	);

	const resolvedState = new Map(unconflicted);
	applyEvents(sortedPower, roomState, resolvedState);

	const sortedOther = reverseTopologicalPowerOrder(
		conflictedOther,
		authEvents,
		roomState,
	);
	applyEvents(sortedOther, roomState, resolvedState);

	return resolvedState;
};
