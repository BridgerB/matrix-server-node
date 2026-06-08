import { MatrixError } from "../errors.ts";
import { matchesRoomEventFilter } from "../event-filter.ts";
import { pduToClientEvent } from "../events.ts";
import { getIgnoredUsers } from "../ignored-users.ts";
import { getIgnoredInviteSenders } from "../ignored-invites.ts";
import { evaluatePushRules, getOrInitRules } from "../push-rules.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	ClientEvent,
	PDU,
	StrippedStateEvent,
} from "../types/events.ts";
import type {
	RoomEventFilter,
	StateFilter,
	SyncFilter,
} from "../types/filters.ts";
import type { DeviceId, EventId, RoomId, UserId } from "../types/index.ts";
import type { PushRulesContent } from "../types/push.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
import type {
	DeviceLists,
	InvitedRoom,
	JoinedRoom,
	KnockedRoom,
	LeftRoom,
	RoomSummary,
	SyncResponse,
	UnreadNotificationCounts,
} from "../types/sync.ts";

/**
 * Build the `rooms.knock` entry for a room the user has knocked on. Prefers the
 * stripped state stashed on the knock event's `unsigned.knock_room_state` (set
 * for federated knocks); otherwise falls back to the room's stripped state, and
 * always ensures the knocking user's own member event (carrying the knock
 * `reason`) is present.
 */
const buildKnockRoom = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
): Promise<KnockedRoom> => {
	const memberEvt = await storage.getStateEvent(roomId, "m.room.member", userId);
	const knockRoomState = (
		memberEvt?.event.unsigned as Record<string, unknown> | undefined
	)?.knock_room_state as StrippedStateEvent[] | undefined;
	const events: StrippedStateEvent[] =
		knockRoomState && knockRoomState.length > 0
			? [...knockRoomState]
			: await storage.getStrippedState(roomId);
	if (
		memberEvt &&
		!events.some((e) => e.type === "m.room.member" && e.state_key === userId)
	) {
		const pdu = memberEvt.event;
		events.push({
			content: pdu.content,
			sender: pdu.sender,
			state_key: pdu.state_key ?? userId,
			type: pdu.type,
		});
	}
	return { knock_state: { events } };
};

const DEFAULT_TIMELINE_LIMIT = 20;
const MAX_TIMEOUT = 30000;

interface ResolvedFilter {
	timelineLimit: number;
	lazyLoadMembers: boolean;
	includeLeave: boolean;
	/**
	 * MSC3773: when set via `room.timeline.unread_thread_notifications`, joined
	 * rooms carry a per-thread `unread_thread_notifications` breakdown and
	 * `unread_notifications` reflects only the main timeline. When unset, the
	 * thread counts are folded into `unread_notifications`.
	 */
	unreadThreadNotifications: boolean;
	timelineFilter?: RoomEventFilter;
	stateFilter?: StateFilter;
}

const resolveFilter = async (
	storage: Storage,
	userId: UserId,
	filterParam: string | null,
): Promise<ResolvedFilter> => {
	const defaults: ResolvedFilter = {
		timelineLimit: DEFAULT_TIMELINE_LIMIT,
		lazyLoadMembers: false,
		includeLeave: false,
		unreadThreadNotifications: false,
	};
	if (filterParam === null) return defaults;

	let filter: SyncFilter | undefined;
	if (filterParam.startsWith("{")) {
		try {
			filter = JSON.parse(filterParam) as SyncFilter;
		} catch {
			return defaults;
		}
	} else {
		// It's a filter ID
		const stored = await storage.getFilter(userId, filterParam);
		if (stored) {
			filter = stored as SyncFilter;
		}
	}

	if (!filter) return defaults;

	return {
		timelineLimit:
			filter.room?.timeline?.limit ?? DEFAULT_TIMELINE_LIMIT,
		lazyLoadMembers:
			filter.room?.state?.lazy_load_members ?? false,
		includeLeave: filter.room?.include_leave ?? false,
		unreadThreadNotifications:
			filter.room?.timeline?.unread_thread_notifications ?? false,
		timelineFilter: filter.room?.timeline,
		stateFilter: filter.room?.state,
	};
};

/**
 * Apply a sync timeline filter to a list of timeline events. `limit` is handled
 * separately by the caller; this only applies type/sender/url predicates.
 */
const applyTimelineFilter = (
	events: ClientEvent[],
	filter: RoomEventFilter | undefined,
): ClientEvent[] => {
	if (!filter) return events;
	return events.filter((e) => matchesRoomEventFilter(e, filter));
};

/**
 * MSC4115: compute the syncing user's membership as of each event in the room.
 *
 * Walks the room's full forward-ordered timeline tracking the user's membership.
 * Returns a map from eventId -> the user's membership "at" that event. For the
 * user's own membership events, the membership reflects the state *after* the
 * event is applied (so the user's own join event reports "join"). For all other
 * events it reflects the membership in effect immediately before the event.
 *
 * Defaults to "leave" before the user has any membership in the room.
 */
const computeMembershipMap = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
): Promise<Map<EventId, string>> => {
	const all = await storage.getEventsByRoom(roomId, 100000, undefined, "f");
	const map = new Map<EventId, string>();
	let current = "leave";
	for (const { event, eventId } of all.events) {
		if (
			event.type === "m.room.member" &&
			event.state_key === userId
		) {
			// The user's own membership transition: the new membership applies to
			// this event and all subsequent events.
			const membership = (event.content as Record<string, unknown>)
				.membership;
			if (typeof membership === "string") current = membership;
			map.set(eventId, current);
		} else {
			map.set(eventId, current);
		}
	}
	return map;
};

/**
 * Stamp `unsigned.membership` (MSC4115) onto each client event using a precomputed
 * membership map. Events not present in the map (should not happen) default to
 * "leave".
 */
const stampMembership = (
	events: ClientEvent[],
	membershipMap: Map<EventId, string>,
): void => {
	for (const ev of events) {
		const membership = membershipMap.get(ev.event_id as EventId) ?? "leave";
		const unsigned = (ev.unsigned ?? {}) as Record<string, unknown>;
		unsigned.membership = membership;
		(ev as { unsigned?: unknown }).unsigned = unsigned;
	}
};

const collectJoinedUsers = async (
	storage: Storage,
	roomId: RoomId,
): Promise<UserId[]> => {
	const members = await storage.getMemberEvents(roomId);
	return members
		.filter(
			(m) =>
				(m.event.content as Record<string, unknown>).membership === "join" &&
				m.event.state_key,
		)
		.map((m) => m.event.state_key as UserId);
};

const buildPresenceEvents = async (
	storage: Storage,
	seenUsers: Set<UserId>,
): Promise<ClientEvent[]> => {
	const events: ClientEvent[] = [];
	for (const uid of seenUsers) {
		const p = await storage.getPresence(uid);
		if (!p) continue;
		const content: Record<string, unknown> = { presence: p.presence };
		if (p.status_msg) content.status_msg = p.status_msg;
		if (p.last_active_ts)
			content.last_active_ago = Date.now() - p.last_active_ts;
		events.push({
			type: "m.presence",
			content,
			sender: uid,
		} as unknown as ClientEvent);
	}
	return events;
};

interface ReceiptRecord {
	eventId: string;
	receiptType: string;
	userId: string;
	ts: number;
	/**
	 * MSC4102/threaded receipts: the thread root event ID, or the literal
	 * "main" for the main timeline. Absent for unthreaded receipts. Storage may
	 * not yet persist this field (see report), in which case it is undefined and
	 * the receipt is emitted unthreaded.
	 */
	threadId?: string;
}

const buildReceiptContent = (
	receipts: ReceiptRecord[],
): Record<string, unknown> => {
	const content: Record<
		string,
		Record<string, Record<string, { ts: number; thread_id?: string }>>
	> = {};
	for (const { eventId, receiptType, userId, ts, threadId } of receipts) {
		if (!content[eventId]) content[eventId] = {};
		const eventContent = content[eventId] as Record<
			string,
			Record<string, { ts: number; thread_id?: string }>
		>;
		if (!eventContent[receiptType]) eventContent[receiptType] = {};
		const receipt: { ts: number; thread_id?: string } = { ts };
		// Per MSC4102, a threaded receipt carries `thread_id` (a thread root event
		// ID or "main"); an unthreaded receipt omits it entirely.
		if (threadId !== undefined) receipt.thread_id = threadId;
		(
			eventContent[receiptType] as Record<
				string,
				{ ts: number; thread_id?: string }
			>
		)[userId] = receipt;
	}
	return content;
};

const buildEphemeralEvents = async (
	storage: Storage,
	roomId: RoomId,
	forUserId: UserId,
): Promise<ClientEvent[]> => {
	const events: ClientEvent[] = [
		{
			type: "m.typing",
			content: { user_ids: await storage.getTypingUsers(roomId) },
		} as unknown as ClientEvent,
	];
	const receipts = await storage.getReceipts(roomId);
	// Filter private receipts: m.read.private only visible to the owning user
	const visibleReceipts = receipts.filter(
		(r) =>
			r.receiptType !== "m.read.private" || r.userId === forUserId,
	);
	if (visibleReceipts.length > 0) {
		events.push({
			type: "m.receipt",
			content: buildReceiptContent(visibleReceipts),
		} as unknown as ClientEvent);
	}
	return events;
};

/**
 * The "main timeline" thread sentinel (MSC3771). An event that is not part of
 * any thread belongs to the main timeline; threaded read receipts for it carry
 * `thread_id: "main"`.
 */
const MAIN_TIMELINE = "main";

/**
 * MSC3771: determine which thread a notifiable event counts towards.
 *
 * Mirrors Synapse `RelationsWorkerStore.get_thread_id`: walk *up* the relation
 * chain from this event towards its root (following `m.relates_to.event_id`). If
 * any link in that chain is an `m.thread` relation, the event counts towards that
 * thread (identified by the thread root's event ID — the deepest `m.thread`
 * parent). Otherwise it belongs to the main timeline.
 *
 * `relations` maps an event ID to its parent (the event it relates to) and the
 * relation type. The walk is depth-bounded (Synapse bounds at depth 3) to avoid
 * cycles in malformed data.
 */
const threadIdForEvent = (
	eventId: string,
	relations: Map<string, { parentId: string; relType: string }>,
): string => {
	let foundThreadRoot: string | undefined;
	let currentId = eventId;
	for (let depth = 0; depth <= 3; depth++) {
		const rel = relations.get(currentId);
		if (!rel) break;
		if (rel.relType === "m.thread") {
			// Record the thread root; keep walking in case a deeper m.thread exists
			// (it should not, but matches Synapse's ORDER BY depth DESC preference).
			foundThreadRoot = rel.parentId;
		}
		currentId = rel.parentId;
	}
	return foundThreadRoot ?? MAIN_TIMELINE;
};

interface ThreadedNotifResult {
	main: UnreadNotificationCounts;
	/** Per-thread breakdown keyed by thread root event ID (excludes main). */
	threads: Map<string, UnreadNotificationCounts>;
}

/**
 * MSC3771/MSC3773: compute per-thread unread notification counts for a room.
 *
 * For each notifiable event (sender !== user, evaluating to `notify`), determine
 * its thread via {@link threadIdForEvent} and count it only if it is *unread*
 * relative to the user's read receipts. Following Synapse's
 * `_get_unread_counts_by_receipt_txn`, an event in thread T is unread iff its
 * position is strictly after BOTH:
 *   - the user's threaded receipt for T (if any), and
 *   - the user's most recent unthreaded receipt (which acts as a floor across
 *     every thread, including main).
 *
 * Event ordering is the room's forward timeline index (a per-room total order),
 * which is sufficient for "after the receipt" comparisons. The full room timeline
 * is scanned (not just the sync window) so counts remain correct as history grows.
 */
const computeThreadedNotificationCounts = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
	userRules: PushRulesContent,
	ignoredUsers: Set<UserId>,
): Promise<ThreadedNotifResult> => {
	const all = await storage.getEventsByRoom(roomId, 100000, undefined, "f");
	const ordered = all.events;

	// Forward-timeline index per event ID — our per-room total ordering.
	const orderOf = new Map<string, number>();
	// Relation graph: child event ID -> { parent, relType }.
	const relations = new Map<string, { parentId: string; relType: string }>();
	for (let i = 0; i < ordered.length; i++) {
		const { event, eventId } = ordered[i]!;
		orderOf.set(eventId, i);
		const relatesTo = (event.content as Record<string, unknown>)[
			"m.relates_to"
		] as { rel_type?: string; event_id?: string } | undefined;
		if (relatesTo?.rel_type && relatesTo.event_id) {
			relations.set(eventId, {
				parentId: relatesTo.event_id,
				relType: relatesTo.rel_type,
			});
		}
	}

	// Receipt cutoffs. `threadReceiptPos` maps a thread ID (root event ID or
	// "main") to the ordering of that thread's threaded read receipt.
	// `unthreadedReceiptPos` is the ordering of the most recent unthreaded read
	// receipt, applied as a floor across all threads.
	const receipts = await storage.getReceipts(roomId);
	const threadReceiptPos = new Map<string, number>();
	let unthreadedReceiptPos = -1;
	for (const r of receipts) {
		if (r.userId !== userId) continue;
		if (r.receiptType !== "m.read" && r.receiptType !== "m.read.private")
			continue;
		const pos = orderOf.get(r.eventId);
		if (pos === undefined) continue;
		if (r.threadId === undefined) {
			if (pos > unthreadedReceiptPos) unthreadedReceiptPos = pos;
		} else {
			const existing = threadReceiptPos.get(r.threadId);
			if (existing === undefined || pos > existing)
				threadReceiptPos.set(r.threadId, pos);
		}
	}

	const profile = await storage.getProfile(userId);
	const displayName = profile?.displayname ?? undefined;
	const memberEvents = await storage.getMemberEvents(roomId);
	const memberCount = memberEvents.filter(
		(m) => (m.event.content as Record<string, unknown>).membership === "join",
	).length;
	const plEvent = await storage.getStateEvent(
		roomId,
		"m.room.power_levels",
		"",
	);
	const powerLevels = plEvent
		? (plEvent.event.content as unknown as RoomPowerLevelsContent)
		: undefined;
	const getSenderPl = (sender: UserId): number => {
		if (!powerLevels) return 0;
		return powerLevels.users?.[sender] ?? powerLevels.users_default ?? 0;
	};

	const main: UnreadNotificationCounts = {
		notification_count: 0,
		highlight_count: 0,
	};
	const threads = new Map<string, UnreadNotificationCounts>();

	for (const { event, eventId } of ordered) {
		if (event.sender === userId) continue;
		if (ignoredUsers.has(event.sender as UserId)) continue;
		const pos = orderOf.get(eventId)!;
		const threadId = threadIdForEvent(eventId, relations);
		const threadReceipt = threadReceiptPos.get(threadId) ?? -1;
		// Unread iff strictly after both the thread receipt and the unthreaded floor.
		if (pos <= threadReceipt || pos <= unthreadedReceiptPos) continue;

		const result = evaluatePushRules(userRules, {
			event,
			userId,
			displayName,
			memberCount,
			powerLevels,
			senderPowerLevel: getSenderPl(event.sender),
		});
		if (!result.notify) continue;

		const bucket =
			threadId === MAIN_TIMELINE
				? main
				: (threads.get(threadId) ??
					(() => {
						const c: UnreadNotificationCounts = {
							notification_count: 0,
							highlight_count: 0,
						};
						threads.set(threadId, c);
						return c;
					})());
		bucket.notification_count = (bucket.notification_count ?? 0) + 1;
		if (result.highlight)
			bucket.highlight_count = (bucket.highlight_count ?? 0) + 1;
	}

	return { main, threads };
};

/**
 * Apply the MSC3771/MSC3773 threaded notification breakdown to a joined-room
 * object, replacing the legacy single `unread_notifications` block.
 *
 * - When the client requested `unread_thread_notifications` (via the sync
 *   filter), `unread_notifications` reflects only the main timeline and a
 *   per-thread `unread_thread_notifications` map (excluding empty threads) is
 *   attached.
 * - Otherwise the thread counts are folded into `unread_notifications` so the
 *   single block reflects the whole room (Synapse handlers/sync.py).
 */
const applyThreadedNotifications = (
	room: JoinedRoom,
	counts: ThreadedNotifResult,
	wantThreadBreakdown: boolean,
): void => {
	const mainNotif = counts.main.notification_count ?? 0;
	const mainHl = counts.main.highlight_count ?? 0;

	if (wantThreadBreakdown) {
		room.unread_notifications = {
			notification_count: mainNotif,
			highlight_count: mainHl,
		};
		const threadMap: Record<string, UnreadNotificationCounts> = {};
		for (const [threadId, c] of counts.threads) {
			if ((c.notification_count ?? 0) === 0 && (c.highlight_count ?? 0) === 0)
				continue;
			threadMap[threadId] = {
				notification_count: c.notification_count ?? 0,
				highlight_count: c.highlight_count ?? 0,
			};
		}
		// Only attach the field when at least one thread has notifications, so a
		// fully-read room reports no `unread_thread_notifications` at all.
		if (Object.keys(threadMap).length > 0) {
			room.unread_thread_notifications = threadMap;
		}
	} else {
		let notif = mainNotif;
		let hl = mainHl;
		for (const c of counts.threads.values()) {
			notif += c.notification_count ?? 0;
			hl += c.highlight_count ?? 0;
		}
		room.unread_notifications = {
			notification_count: notif,
			highlight_count: hl,
		};
	}
};

const buildRoomSummary = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
): Promise<RoomSummary> => {
	const members = await storage.getMemberEvents(roomId);
	let joinedCount = 0;
	let invitedCount = 0;
	const heroes: UserId[] = [];

	for (const m of members) {
		const membership = (m.event.content as Record<string, unknown>)
			.membership as string;
		const stateKey = m.event.state_key as UserId;
		if (membership === "join") {
			joinedCount++;
			if (stateKey !== userId && heroes.length < 5) {
				heroes.push(stateKey);
			}
		} else if (membership === "invite") {
			invitedCount++;
			if (stateKey !== userId && heroes.length < 5) {
				heroes.push(stateKey);
			}
		}
	}

	return {
		"m.heroes": heroes.length > 0 ? heroes : undefined,
		"m.joined_member_count": joinedCount,
		"m.invited_member_count": invitedCount,
	};
};

/**
 * Build the `rooms.leave` entry for a room the user has left or been banned
 * from. Archived rooms must only contain history from before the user left,
 * so we reconstruct the room state as of the user's leave event and only
 * include timeline events up to (and including) that point.
 *
 * Returns undefined when there is nothing to report (e.g. the leave event is
 * not yet visible, or — for incremental sync — the leave did not happen in
 * this sync window).
 */
const buildLeaveRoom = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
	filter: ResolvedFilter,
	/**
	 * For incremental sync, only emit the room if the user's leave/ban event is
	 * newer than this stream position. Pass undefined for initial sync.
	 */
	since: number | undefined,
): Promise<LeftRoom | undefined> => {
	// Pull the full forward-ordered event list for the room. Archived rooms in
	// this server are small, so reading the whole timeline is acceptable.
	const all = await storage.getEventsByRoom(roomId, 100000, undefined, "f");
	const ordered = all.events;

	// Find the user's own leave/ban membership event (the most recent one).
	let leaveIdx = -1;
	for (let i = 0; i < ordered.length; i++) {
		const ev = ordered[i]!.event;
		if (ev.type === "m.room.member" && ev.state_key === userId) {
			const membership = (ev.content as Record<string, unknown>).membership;
			if (membership === "leave" || membership === "ban") {
				leaveIdx = i;
			}
		}
	}
	if (leaveIdx === -1) return undefined;

	const leaveEventId = ordered[leaveIdx]!.eventId;
	// For incremental sync, only report rooms where the leave event is new in
	// this sync window. getEventsByRoomSince returns events with stream_pos >
	// since, so if the leave event appears there it happened during the window.
	let sinceEventIds: Set<EventId> | undefined;
	if (since !== undefined) {
		const sinceRes = await storage.getEventsByRoomSince(roomId, since, 100000);
		sinceEventIds = new Set(sinceRes.events.map((e) => e.eventId));
		if (!sinceEventIds.has(leaveEventId)) return undefined;
	}

	// Events up to and including the user's leave.
	const upToLeave = ordered.slice(0, leaveIdx + 1);

	// Reconstruct state as of the leave point by folding all state events from
	// the room's history up to the leave.
	const stateAtLeave = new Map<string, { event: PDU; eventId: EventId }>();
	for (const entry of upToLeave) {
		if (entry.event.state_key !== undefined) {
			const key = `${entry.event.type}\0${entry.event.state_key}`;
			stateAtLeave.set(key, entry);
		}
	}

	// Timeline candidates: events up to the leave. For incremental sync, only
	// include events that are new in this window (stream_pos > since); for
	// initial sync, include the whole history up to the leave.
	const timelineCandidates =
		sinceEventIds === undefined
			? upToLeave
			: upToLeave.filter((e) => sinceEventIds!.has(e.eventId));

	// Timeline: tail of the candidates, limited, then type-filtered.
	const tail = timelineCandidates.slice(
		Math.max(0, timelineCandidates.length - filter.timelineLimit),
	);
	const limited = timelineCandidates.length > filter.timelineLimit;
	let timelineClientEvents = tail.map((e) =>
		pduToClientEvent(e.event, e.eventId),
	);
	timelineClientEvents = applyTimelineFilter(
		timelineClientEvents,
		filter.timelineFilter,
	);
	const timelineIds = new Set(tail.map((e) => e.eventId));

	// State section.
	//  - Initial sync: the full room state as of the leave point, minus what is
	//    already in the timeline.
	//  - Incremental sync: only the state changes within this window (i.e. state
	//    events newer than `since`) that fell outside the limited timeline. This
	//    keeps incremental responses to a delta, matching Synapse.
	const stateCandidates =
		sinceEventIds === undefined
			? [...stateAtLeave.values()]
			: [...stateAtLeave.values()].filter((e) =>
					sinceEventIds!.has(e.eventId),
				);
	let stateEntries = stateCandidates.filter(
		(e) => !timelineIds.has(e.eventId),
	);
	if (filter.stateFilter) {
		stateEntries = stateEntries.filter((e) =>
			matchesRoomEventFilter(
				pduToClientEvent(e.event, e.eventId),
				filter.stateFilter,
			),
		);
	}
	const stateClientEvents = stateEntries.map((e) =>
		pduToClientEvent(e.event, e.eventId),
	);

	const room: LeftRoom = {
		state:
			stateClientEvents.length > 0 ? { events: stateClientEvents } : undefined,
		timeline: {
			events: timelineClientEvents,
			limited: limited || undefined,
		},
	};
	return room;
};

/**
 * MSC4222: attach the `state_after` block (both the stable `state_after` key and
 * the unstable `org.matrix.msc4222.state_after` key) to a joined-room object, and
 * blank out the legacy `state` block (MSC4222 replaces it when use_state_after is
 * set). `JoinedRoom` does not declare these unstable keys, so we cast.
 */
const attachStateAfter = (
	room: JoinedRoom,
	stateAfterEvents: ClientEvent[],
): void => {
	const block = { events: stateAfterEvents };
	const r = room as JoinedRoom & {
		state_after?: { events: ClientEvent[] };
		"org.matrix.msc4222.state_after"?: { events: ClientEvent[] };
	};
	// MSC4222 replaces `state` with `state_after`; omit the legacy block.
	r.state = undefined;
	r.state_after = block;
	r["org.matrix.msc4222.state_after"] = block;
};

const buildInitialSync = async (
	storage: Storage,
	userId: UserId,
	deviceId: DeviceId,
	nextBatch: number,
	filter: ResolvedFilter,
	useStateAfter: boolean,
): Promise<SyncResponse> => {
	const userRooms = await storage.getRoomsForUserWithMembership(userId);

	const join: Record<RoomId, JoinedRoom> = {};
	const invite: Record<RoomId, InvitedRoom> = {};
	const knock: Record<RoomId, KnockedRoom> = {};
	const leave: Record<RoomId, LeftRoom> = {};
	const userRules = await getOrInitRules(storage, userId);
	const ignoredUsers = await getIgnoredUsers(storage, userId);
	const ignoredInviteSenders = await getIgnoredInviteSenders(storage, userId);

	for (const { roomId, membership } of userRooms) {
		// A forgotten room must not appear in an initial sync at all.
		const forgottenMarker = await storage.getRoomAccountData(
			userId,
			roomId,
			"m.internal.forgotten",
		);
		if ((forgottenMarker as { forgotten?: boolean } | undefined)?.forgotten) {
			continue;
		}
		if (membership === "join") {
			const result = await storage.getEventsByRoom(
				roomId,
				filter.timelineLimit,
				undefined,
				"b",
			);
			const timelineEvents = result.events.reverse();

			const allState = await storage.getAllState(roomId);

			let timelineClientEvents = timelineEvents.map((e) =>
				pduToClientEvent(e.event, e.eventId),
			);

			if (ignoredUsers.size > 0) {
				timelineClientEvents = timelineClientEvents.filter(
					(e) =>
						e.state_key !== undefined ||
						!ignoredUsers.has(e.sender),
				);
			}

			// Apply the timeline filter (types/not_types/senders/contains_url).
			// State events removed here must still surface in the `state` block, so
			// the set we exclude from state is computed from the *filtered* timeline
			// below — not from the raw window. (Matches Synapse `_calculate_state`,
			// where `state = current_state - timeline_contains` and
			// `timeline_contains` is the post-filter timeline.)
			timelineClientEvents = applyTimelineFilter(
				timelineClientEvents,
				filter.timelineFilter,
			);

			// Events still present in the timeline after filtering are already known
			// to the client, so they are excluded from the `state` block.
			const timelineEventIds = new Set(
				timelineClientEvents.map((e) => e.event_id as EventId),
			);
			let stateEntries = allState
				.filter((e) => !timelineEventIds.has(e.eventId));

			// When lazy_load_members is enabled, only include member events
			// for users who appear in the timeline
			if (filter.lazyLoadMembers) {
				const timelineSenders = new Set<string>();
				for (const ev of timelineClientEvents) {
					timelineSenders.add(ev.sender);
					if (ev.type === "m.room.member" && ev.state_key) {
						timelineSenders.add(ev.state_key);
					}
				}
				stateEntries = stateEntries.filter(
					(e) =>
						e.event.type !== "m.room.member" ||
						timelineSenders.has(e.event.state_key ?? ""),
				);
			}

			const stateEvents = stateEntries.map((e) =>
				pduToClientEvent(e.event, e.eventId),
			);

			await bundleAggregations(storage, timelineClientEvents, userId);

			// MSC4115: stamp the syncing user's membership onto each timeline event.
			const membershipMap = await computeMembershipMap(
				storage,
				roomId,
				userId,
			);
			stampMembership(timelineClientEvents, membershipMap);

			const totalEvents = await storage.getEventsByRoom(
				roomId,
				filter.timelineLimit + 1,
				undefined,
				"b",
			);
			const limited = totalEvents.events.length > filter.timelineLimit;

			// prev_batch is always present. For a limited timeline it points at the
			// start of the window (so /messages?dir=b backfills older events); for an
			// unlimited timeline it is the current stream position, which also serves
			// as a valid `at` token for GET /members?at=… (state as of this sync).
			const prevBatch =
				limited && result.end !== undefined
					? String(result.end)
					: String(await storage.getStreamPosition());

			const summary = await buildRoomSummary(storage, roomId, userId);

			join[roomId] = {
				summary,
				state: stateEvents.length > 0 ? { events: stateEvents } : undefined,
				timeline: {
					events: timelineClientEvents,
					limited: limited || undefined,
					prev_batch: prevBatch,
				},
			};

			// MSC3771/MSC3773: compute per-thread unread notification counts over
			// the full room timeline relative to the user's read receipts, then
			// attach either a folded `unread_notifications` block or the per-thread
			// breakdown depending on the sync filter.
			const threadedCounts = await computeThreadedNotificationCounts(
				storage,
				roomId,
				userId,
				userRules,
				ignoredUsers,
			);
			applyThreadedNotifications(
				join[roomId] as JoinedRoom,
				threadedCounts,
				filter.unreadThreadNotifications,
			);

			if (useStateAfter) {
				// MSC4222 initial sync: state_after is the full current room state
				// (the state *after* the returned timeline batch). Unlike the legacy
				// `state` block, timeline state events are NOT excluded — state_after
				// must reflect the complete post-timeline state.
				let stateAfterEntries = allState;
				if (filter.lazyLoadMembers) {
					// Keep member events only for senders/targets present in the
					// timeline (mirrors the lazy-load behaviour of the legacy block).
					const timelineSenders = new Set<string>();
					for (const ev of timelineClientEvents) {
						timelineSenders.add(ev.sender);
						if (ev.type === "m.room.member" && ev.state_key) {
							timelineSenders.add(ev.state_key);
						}
					}
					stateAfterEntries = stateAfterEntries.filter(
						(e) =>
							e.event.type !== "m.room.member" ||
							timelineSenders.has(e.event.state_key ?? ""),
					);
				}
				attachStateAfter(
					join[roomId] as JoinedRoom,
					stateAfterEntries.map((e) =>
						pduToClientEvent(e.event, e.eventId),
					),
				);
			}
		} else if (membership === "invite") {
			const stripped = await storage.getStrippedState(roomId);
			const inviterEvent = stripped.find(
				(e) =>
					e.type === "m.room.member" &&
					e.state_key === userId &&
					(e.content as Record<string, unknown>).membership === "invite",
			);
			const inviter = inviterEvent?.sender as UserId | undefined;
			if (inviter && (ignoredUsers.has(inviter) || ignoredInviteSenders.has(inviter))) continue;
			invite[roomId] = { invite_state: { events: stripped } };
		} else if (membership === "knock") {
			knock[roomId] = await buildKnockRoom(storage, roomId as RoomId, userId);
		} else if (
			(membership === "leave" || membership === "ban") &&
			filter.includeLeave
		) {
			const leftRoom = await buildLeaveRoom(
				storage,
				roomId,
				userId,
				filter,
				undefined,
			);
			if (leftRoom) leave[roomId] = leftRoom;
		}
	}

	const globalData = await storage.getAllGlobalAccountData(userId);
	const accountDataEvents = globalData.map(
		(d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent,
	);

	const seenUsers = new Set<UserId>();
	for (const roomId of Object.keys(join)) {
		const roomData = await storage.getAllRoomAccountData(userId, roomId);
		// Always emit account_data.events (even empty) so clients can rely on the
		// path existing for a joined room.
		(join[roomId] as JoinedRoom).account_data = {
			events: roomData.map(
				(d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent,
			),
		};

		(join[roomId] as JoinedRoom).ephemeral = {
			events: await buildEphemeralEvents(storage, roomId as RoomId, userId),
		};

		const users = await collectJoinedUsers(storage, roomId as RoomId);
		for (const u of users) seenUsers.add(u);
	}

	const presenceEvents = await buildPresenceEvents(storage, seenUsers);

	const toDeviceEvents = await storage.getToDeviceMessages(userId, deviceId);
	if (toDeviceEvents.length > 0) {
		await storage.clearToDeviceMessages(userId, deviceId);
	}

	const otkCounts = await storage.getOneTimeKeyCounts(userId, deviceId);
	const fallbackKeyTypes = await storage.getFallbackKeyTypes(userId, deviceId);

	return {
		next_batch: String(nextBatch),
		account_data:
			accountDataEvents.length > 0 ? { events: accountDataEvents } : undefined,
		presence:
			presenceEvents.length > 0 ? { events: presenceEvents } : undefined,
		rooms: {
			join: Object.keys(join).length > 0 ? join : undefined,
			invite: Object.keys(invite).length > 0 ? invite : undefined,
			knock: Object.keys(knock).length > 0 ? knock : undefined,
			leave: Object.keys(leave).length > 0 ? leave : undefined,
		},
		to_device:
			toDeviceEvents.length > 0 ? { events: toDeviceEvents } : undefined,
		device_one_time_keys_count: otkCounts,
		device_unused_fallback_key_types: fallbackKeyTypes,
	};
};
const buildIncrementalSync = async (
	storage: Storage,
	userId: UserId,
	deviceId: DeviceId,
	since: number,
	nextBatch: number,
	fullState: boolean,
	filter: ResolvedFilter,
	useStateAfter: boolean,
): Promise<SyncResponse> => {
	const userRooms = await storage.getRoomsForUserWithMembership(userId);

	const join: Record<RoomId, JoinedRoom> = {};
	const invite: Record<RoomId, InvitedRoom> = {};
	const knock: Record<RoomId, KnockedRoom> = {};
	const leave: Record<RoomId, LeftRoom> = {};
	const seenUsers = new Set<UserId>();
	// Users who newly joined/were invited/knocked on a room we share within this
	// sync window. Per the spec and Synapse's
	// `DeviceHandler.generate_sync_entry_for_device_list` (Step 1b), these users
	// must appear in `device_lists.changed` even if they did not upload keys —
	// the syncing client needs to fetch their device list because it now shares a
	// room with them. See handlers/device.py:755-762.
	const newlyJoinedOrInvitedUsers = new Set<UserId>();
	const userRules = await getOrInitRules(storage, userId);
	const ignoredUsers = await getIgnoredUsers(storage, userId);
	const ignoredInviteSenders = await getIgnoredInviteSenders(storage, userId);

	for (const { roomId, membership } of userRooms) {
		if (membership === "join") {
			const { events: newEvents, limited } = await storage.getEventsByRoomSince(
				roomId,
				since,
				filter.timelineLimit,
			);

			let timelineClientEvents = newEvents.map((e) =>
				pduToClientEvent(e.event, e.eventId),
			);

			if (ignoredUsers.size > 0) {
				timelineClientEvents = timelineClientEvents.filter(
					(e) =>
						e.state_key !== undefined ||
						!ignoredUsers.has(e.sender),
				);
			}

			// Apply the timeline filter. State events removed by the filter must
			// still be reported in the `state` block (see Synapse `_calculate_state`),
			// so the exclusion set below is computed from the filtered timeline.
			timelineClientEvents = applyTimelineFilter(
				timelineClientEvents,
				filter.timelineFilter,
			);

			await bundleAggregations(storage, timelineClientEvents, userId);

			// MSC4115: stamp the syncing user's membership onto each timeline event.
			if (timelineClientEvents.length > 0) {
				const membershipMap = await computeMembershipMap(
					storage,
					roomId,
					userId,
				);
				stampMembership(timelineClientEvents, membershipMap);
			}

			// Event IDs surviving the timeline filter — these are already delivered to
			// the client and must be excluded from the `state` block.
			const filteredTimelineIds = new Set(
				timelineClientEvents.map((e) => e.event_id as EventId),
			);

			let stateClientEvents: ClientEvent[] = [];
			if (fullState) {
				const allState = await storage.getAllState(roomId);
				let stateEntries = allState
					.filter((e) => !filteredTimelineIds.has(e.eventId));

				if (filter.lazyLoadMembers) {
					const timelineSenders = new Set<string>();
					for (const ev of timelineClientEvents) {
						timelineSenders.add(ev.sender);
						if (ev.type === "m.room.member" && ev.state_key) {
							timelineSenders.add(ev.state_key);
						}
					}
					stateEntries = stateEntries.filter(
						(e) =>
							e.event.type !== "m.room.member" ||
							timelineSenders.has(e.event.state_key ?? ""),
					);
				}

				stateClientEvents = stateEntries
					.map((e) => pduToClientEvent(e.event, e.eventId));
			} else {
				// Incremental (delta) sync: report state events that arrived within
				// this window (since, nextBatch] but did NOT survive the timeline
				// filter (e.g. excluded by not_types) or fell outside the limited
				// timeline tail. Without this, a state change filtered out of the
				// timeline would silently never reach the client.
				const windowRes = await storage.getEventsByRoomSince(
					roomId,
					since,
					100000,
				);
				const stateDelta = windowRes.events.filter(
					(e) =>
						e.event.state_key !== undefined &&
						!filteredTimelineIds.has(e.eventId),
				);
				stateClientEvents = stateDelta.map((e) =>
					pduToClientEvent(e.event, e.eventId),
				);
			}

			const prevBatch =
				limited && newEvents.length > 0
					? String((newEvents[0] as (typeof newEvents)[number]).streamPos - 1)
					: undefined;

			const ephemeralEvents = await buildEphemeralEvents(storage, roomId, userId);

			if (
				timelineClientEvents.length > 0 ||
				stateClientEvents.length > 0 ||
				ephemeralEvents.length > 0
			) {
				const summary = await buildRoomSummary(storage, roomId, userId);

				join[roomId] = {
					summary,
					state:
						stateClientEvents.length > 0
							? { events: stateClientEvents }
							: undefined,
					timeline: {
						events: timelineClientEvents,
						limited: limited || undefined,
						prev_batch: prevBatch,
					},
					ephemeral: { events: ephemeralEvents },
				};

				// MSC3771/MSC3773: per-thread unread notification counts, computed
				// over the full room timeline relative to read receipts.
				const threadedCounts = await computeThreadedNotificationCounts(
					storage,
					roomId,
					userId,
					userRules,
					ignoredUsers,
				);
				applyThreadedNotifications(
					join[roomId] as JoinedRoom,
					threadedCounts,
					filter.unreadThreadNotifications,
				);

				if (useStateAfter) {
					// MSC4222 incremental sync: state_after is the set of state events
					// that changed within this window (since, nextBatch]. Critically,
					// this INCLUDES state events that also appear in the timeline — e.g.
					// a delayed state event that fires arrives as a timeline event on the
					// waking long-poll and must also surface in state_after. We pull the
					// full window (not just the limited timeline tail) and keep events
					// carrying a state_key.
					const windowRes = await storage.getEventsByRoomSince(
						roomId,
						since,
						100000,
					);
					const stateDelta = windowRes.events.filter(
						(e) => e.event.state_key !== undefined,
					);
					attachStateAfter(
						join[roomId] as JoinedRoom,
						stateDelta.map((e) => pduToClientEvent(e.event, e.eventId)),
					);
				}
			}

			const users = await collectJoinedUsers(storage, roomId);
			for (const u of users) seenUsers.add(u);

			// Step 1b (Synapse handlers/device.py:755-762): scan this shared room's
			// membership transitions within the window (since, nextBatch] for users
			// who newly joined / were invited / are knocking. Their device lists must
			// be surfaced in `device_lists.changed` so the client fetches their keys,
			// independent of whether they pushed a device-list update. This covers the
			// federation room-join case where a remote user joins a room we're in: the
			// inbound member event lands in this window but the user may never upload
			// keys to us.
			const memberWindow = await storage.getEventsByRoomSince(
				roomId,
				since,
				100000,
			);
			let selfNewlyJoined = false;
			for (const { event } of memberWindow.events) {
				if (event.type !== "m.room.member" || !event.state_key) continue;
				const m = (event.content as Record<string, unknown>).membership;
				if (m === "join" || m === "invite" || m === "knock") {
					newlyJoinedOrInvitedUsers.add(event.state_key as UserId);
					if (event.state_key === userId && m === "join") {
						selfNewlyJoined = true;
					}
				}
			}
			// If WE newly joined this room in this window, every user currently in
			// the room is a "newly shared" user from our perspective — we must learn
			// all their device lists. Synapse handlers/device.py:756-758 adds
			// `get_users_in_room(room_id)` for each `newly_joined_rooms` entry. Their
			// own member events predate the window, so the per-event scan above would
			// otherwise miss them.
			if (selfNewlyJoined) {
				for (const u of users) newlyJoinedOrInvitedUsers.add(u);
			}
		} else if (membership === "invite") {
			const { events: newEvents } = await storage.getEventsByRoomSince(
				roomId,
				since,
				filter.timelineLimit,
			);
			const membershipChanged = newEvents.some(
				(e) => e.event.type === "m.room.member" && e.event.state_key === userId,
			);
			if (membershipChanged) {
				const stripped = await storage.getStrippedState(roomId);
				const inviterEvent = stripped.find(
					(e) =>
						e.type === "m.room.member" &&
						e.state_key === userId &&
						(e.content as Record<string, unknown>).membership === "invite",
				);
				const inviter = inviterEvent?.sender as UserId | undefined;
				if (inviter && (ignoredUsers.has(inviter) || ignoredInviteSenders.has(inviter))) continue;
				invite[roomId] = { invite_state: { events: stripped } };
			}
		} else if (membership === "knock") {
			const { events: newEvents } = await storage.getEventsByRoomSince(
				roomId,
				since,
				filter.timelineLimit,
			);
			const membershipChanged = newEvents.some(
				(e) => e.event.type === "m.room.member" && e.event.state_key === userId,
			);
			if (membershipChanged) {
				knock[roomId] = await buildKnockRoom(storage, roomId as RoomId, userId);
			}
		} else if (membership === "leave" || membership === "ban") {
			// Emit a leave room when the user newly left within this sync window.
			// buildLeaveRoom only returns a value when the user's leave/ban event
			// is newer than `since`, which matches the "newly left" semantics —
			// so this fires for both include_leave filters and the default case.
			const leftRoom = await buildLeaveRoom(
				storage,
				roomId,
				userId,
				filter,
				since,
			);
			if (leftRoom) leave[roomId] = leftRoom;
		}
	}

	// Account data changed within this sync window. Global entries go to the
	// top-level account_data; room entries attach to the joined room (creating a
	// minimal join entry if the room is not otherwise present in this response).
	// Tombstones (content `{}`, MSC3391 deletions) are included by the *Since
	// methods so clients can clear deleted account data.
	const globalAccountDataSince = await storage.getGlobalAccountDataSince(
		userId,
		since,
	);
	const accountDataEvents = globalAccountDataSince.map(
		(d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent,
	);

	const joinedRoomIds = new Set(
		userRooms
			.filter((r) => r.membership === "join")
			.map((r) => r.roomId),
	);
	const roomAccountDataSince = await storage.getRoomAccountDataSince(
		userId,
		since,
	);
	const roomAccountDataByRoom = new Map<RoomId, ClientEvent[]>();
	for (const d of roomAccountDataSince) {
		// Only surface room account-data for rooms the user is currently joined to.
		if (!joinedRoomIds.has(d.roomId)) continue;
		let list = roomAccountDataByRoom.get(d.roomId);
		if (!list) {
			list = [];
			roomAccountDataByRoom.set(d.roomId, list);
		}
		list.push({ type: d.type, content: d.content } as unknown as ClientEvent);
	}
	for (const [roomId, events] of roomAccountDataByRoom) {
		let room = join[roomId];
		if (!room) {
			// Room has only account-data changes in this window; still surface it.
			room = {} as JoinedRoom;
			join[roomId] = room;
		}
		room.account_data = { events };
	}

	const presenceEvents = await buildPresenceEvents(storage, seenUsers);

	const toDeviceEvents = await storage.getToDeviceMessages(userId, deviceId);
	if (toDeviceEvents.length > 0) {
		await storage.clearToDeviceMessages(userId, deviceId);
	}

	const otkCounts = await storage.getOneTimeKeyCounts(userId, deviceId);
	const fallbackKeyTypes = await storage.getFallbackKeyTypes(userId, deviceId);

	// Device-list changes (`device_lists.changed`). Per Synapse's
	// `DeviceHandler.generate_sync_entry_for_device_list` this is the union of:
	//   1a. users whose device keys changed within this window (since, nextBatch]
	//       and who currently share a joined room with the syncer; and
	//   1b. users who newly joined / were invited / knocked on a room we share in
	//       this window (collected above), regardless of whether their keys
	//       changed.
	// The syncer themselves is intentionally NOT excluded: a client must learn of
	// its own other devices (e.g. a second login), so self is reported when self's
	// keys changed or self newly joined. `seenUsers` holds every user sharing a
	// joined room with us (including self).
	const changedDeviceUsers = await storage.getChangedDeviceUsers(
		since,
		nextBatch,
	);
	const changed = new Set<UserId>();
	for (const u of changedDeviceUsers) {
		if (seenUsers.has(u)) changed.add(u);
	}
	for (const u of newlyJoinedOrInvitedUsers) {
		changed.add(u);
	}
	const changedDeviceLists = [...changed];
	const deviceLists: DeviceLists | undefined =
		changedDeviceLists.length > 0
			? { changed: changedDeviceLists, left: [] }
			: undefined;

	return {
		next_batch: String(nextBatch),
		device_lists: deviceLists,
		account_data:
			accountDataEvents.length > 0 ? { events: accountDataEvents } : undefined,
		presence:
			presenceEvents.length > 0 ? { events: presenceEvents } : undefined,
		rooms: {
			join: Object.keys(join).length > 0 ? join : undefined,
			invite: Object.keys(invite).length > 0 ? invite : undefined,
			knock: Object.keys(knock).length > 0 ? knock : undefined,
			leave: Object.keys(leave).length > 0 ? leave : undefined,
		},
		to_device:
			toDeviceEvents.length > 0 ? { events: toDeviceEvents } : undefined,
		device_one_time_keys_count: otkCounts,
		device_unused_fallback_key_types: fallbackKeyTypes,
	};
};
export const getSync =
	(storage: Storage, _serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const deviceId = req.deviceId as DeviceId;
		const sinceStr = req.query.get("since");
		const since = sinceStr !== null ? parseInt(sinceStr, 10) : undefined;
		const timeout = Math.min(
			Math.max(parseInt(req.query.get("timeout") ?? "0", 10), 0),
			MAX_TIMEOUT,
		);
		const fullState = req.query.get("full_state") === "true";
		// MSC4222: clients opt in via `use_state_after=true` (stable) or the unstable
		// `org.matrix.msc4222.use_state_after=true`. When set, joined rooms carry a
		// `state_after` block (and the unstable key) instead of `state`.
		const useStateAfter =
			req.query.get("use_state_after") === "true" ||
			req.query.get("org.matrix.msc4222.use_state_after") === "true";
		const filterParam = req.query.get("filter");

		// `set_presence` lets a client set its presence as a side effect of /sync.
		// Only act when explicitly provided (omitting it must not clobber presence).
		const setPresence = req.query.get("set_presence");
		if (
			setPresence === "online" ||
			setPresence === "unavailable" ||
			setPresence === "offline"
		) {
			await storage.setPresence(userId, setPresence);
		}

		// Validate since token
		if (since !== undefined) {
			const currentPos = await storage.getStreamPosition();
			if (since < 0 || since > currentPos) {
				throw new MatrixError("M_UNKNOWN_POS", "Invalid sync token", 400);
			}
		}

		// Resolve filter (inline JSON or filter ID)
		const filter = await resolveFilter(storage, userId, filterParam);

		if (since !== undefined && timeout > 0) {
			await storage.waitForEvents(since, timeout);
		}

		const nextBatch = await storage.getStreamPosition();

		const response: SyncResponse =
			since === undefined
				? await buildInitialSync(
						storage,
						userId,
						deviceId,
						nextBatch,
						filter,
						useStateAfter,
					)
				: await buildIncrementalSync(
						storage,
						userId,
						deviceId,
						since,
						nextBatch,
						fullState,
						filter,
						useStateAfter,
					);

		return { status: 200, body: response };
	};
