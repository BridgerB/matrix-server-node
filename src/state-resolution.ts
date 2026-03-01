import type { PDU } from "./types/events.ts";
import type { EventId } from "./types/index.ts";
import type { RoomState } from "./types/internal.ts";
import { computeEventId, checkEventAuth, getUserPowerLevel } from "./events.ts";

// =============================================================================
// STATE RESOLUTION v2 (Room Versions 2+)
// =============================================================================

const POWER_EVENT_TYPES = new Set([
  "m.room.power_levels",
  "m.room.join_rules",
  "m.room.member",
  "m.room.third_party_invite",
]);

/**
 * Resolve conflicting state from multiple forks.
 *
 * @param stateAtForks - Array of state maps, one per fork
 * @param authEvents - Map of all available auth events
 * @param roomState - The base room state for auth checking
 * @returns Resolved state map
 */
export function resolveState(
  stateAtForks: Map<string, PDU>[],
  authEvents: Map<EventId, PDU>,
  roomState: RoomState,
): Map<string, PDU> {
  if (stateAtForks.length === 0) return new Map();
  if (stateAtForks.length === 1) return new Map(stateAtForks[0]!);

  // 1. Find unconflicted and conflicted state
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
      unconflicted.set(key, events[0]!);
    } else if (events.length > 1) {
      // Partition into power events and other events
      const eventType = key.split("\0")[0]!;
      if (POWER_EVENT_TYPES.has(eventType)) {
        conflictedPower.push(...events);
      } else {
        conflictedOther.push(...events);
      }
    }
  }

  // 2. Sort conflicted power events by reverse topological power ordering
  const sortedPower = reverseTopologicalPowerOrder(conflictedPower, authEvents, roomState);

  // 3. Iteratively apply power events
  const resolvedState = new Map(unconflicted);
  for (const event of sortedPower) {
    const key = event.type + "\0" + (event.state_key ?? "");
    const testState: RoomState = {
      ...roomState,
      state_events: new Map(resolvedState),
    };
    try {
      const eventId = computeEventId(event);
      checkEventAuth(event, eventId, testState);
      resolvedState.set(key, event);
    } catch {
      // Event fails auth, skip it
    }
  }

  // 4. Sort and iteratively apply other events
  const sortedOther = reverseTopologicalPowerOrder(conflictedOther, authEvents, roomState);
  for (const event of sortedOther) {
    const key = event.type + "\0" + (event.state_key ?? "");
    const testState: RoomState = {
      ...roomState,
      state_events: new Map(resolvedState),
    };
    try {
      const eventId = computeEventId(event);
      checkEventAuth(event, eventId, testState);
      resolvedState.set(key, event);
    } catch {
      // Event fails auth, skip it
    }
  }

  return resolvedState;
}

/**
 * Sort events by reverse topological power ordering:
 * 1. Sender power level (descending)
 * 2. origin_server_ts (ascending)
 * 3. Event ID lexicographic (ascending)
 */
function reverseTopologicalPowerOrder(
  events: PDU[],
  _authEvents: Map<EventId, PDU>,
  roomState: RoomState,
): PDU[] {
  return [...events].sort((a, b) => {
    // Primary: sender power level (descending)
    const plA = getUserPowerLevel(a.sender, roomState);
    const plB = getUserPowerLevel(b.sender, roomState);
    if (plA !== plB) return plB - plA;

    // Secondary: origin_server_ts (ascending)
    if (a.origin_server_ts !== b.origin_server_ts) {
      return a.origin_server_ts - b.origin_server_ts;
    }

    // Tertiary: event ID lexicographic (ascending)
    const idA = computeEventId(a);
    const idB = computeEventId(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}
