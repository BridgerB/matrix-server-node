import { MatrixError } from "../errors.ts";
import { pduToClientEvent } from "../events.ts";
import { getIgnoredUsers } from "../ignored-users.ts";
import { getIgnoredInviteSenders } from "../ignored-invites.ts";
import { evaluatePushRules, getOrInitRules } from "../push-rules.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ClientEvent, PDU } from "../types/events.ts";
import type { SyncFilter } from "../types/filters.ts";
import type { DeviceId, RoomId, UserId } from "../types/index.ts";
import type { PushRulesContent } from "../types/push.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";
import type {
	InvitedRoom,
	JoinedRoom,
	LeftRoom,
	RoomSummary,
	SyncResponse,
	UnreadNotificationCounts,
} from "../types/sync.ts";

const DEFAULT_TIMELINE_LIMIT = 20;
const MAX_TIMEOUT = 30000;

interface ResolvedFilter {
	timelineLimit: number;
	lazyLoadMembers: boolean;
}

const resolveFilter = async (
	storage: Storage,
	userId: UserId,
	filterParam: string | null,
): Promise<ResolvedFilter> => {
	const defaults: ResolvedFilter = {
		timelineLimit: DEFAULT_TIMELINE_LIMIT,
		lazyLoadMembers: false,
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
	};
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

const buildReceiptContent = (
	receipts: {
		eventId: string;
		receiptType: string;
		userId: string;
		ts: number;
	}[],
): Record<string, unknown> => {
	const content: Record<
		string,
		Record<string, Record<string, { ts: number }>>
	> = {};
	for (const { eventId, receiptType, userId, ts } of receipts) {
		if (!content[eventId]) content[eventId] = {};
		const eventContent = content[eventId] as Record<
			string,
			Record<string, { ts: number }>
		>;
		if (!eventContent[receiptType]) eventContent[receiptType] = {};
		(eventContent[receiptType] as Record<string, { ts: number }>)[userId] = {
			ts,
		};
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

const computeNotificationCounts = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
	userRules: PushRulesContent,
	timelineEvents: { event: PDU; eventId: string }[],
): Promise<UnreadNotificationCounts> => {
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

	const { notification_count, highlight_count } = timelineEvents
		.filter(({ event }) => event.sender !== userId)
		.reduce(
			(counts, { event }) => {
				const result = evaluatePushRules(userRules, {
					event,
					userId,
					displayName,
					memberCount,
					powerLevels,
					senderPowerLevel: getSenderPl(event.sender),
				});
				if (result.notify) {
					counts.notification_count++;
					if (result.highlight) counts.highlight_count++;
				}
				return counts;
			},
			{ notification_count: 0, highlight_count: 0 },
		);

	return { notification_count, highlight_count };
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

const buildInitialSync = async (
	storage: Storage,
	userId: UserId,
	deviceId: DeviceId,
	nextBatch: number,
	filter: ResolvedFilter,
): Promise<SyncResponse> => {
	const userRooms = await storage.getRoomsForUserWithMembership(userId);

	const join: Record<RoomId, JoinedRoom> = {};
	const invite: Record<RoomId, InvitedRoom> = {};
	const userRules = await getOrInitRules(storage, userId);
	const ignoredUsers = await getIgnoredUsers(storage, userId);
	const ignoredInviteSenders = await getIgnoredInviteSenders(storage, userId);

	for (const { roomId, membership } of userRooms) {
		if (membership === "join") {
			const result = await storage.getEventsByRoom(
				roomId,
				filter.timelineLimit,
				undefined,
				"b",
			);
			const timelineEvents = result.events.reverse();
			const timelineEventIds = new Set(timelineEvents.map((e) => e.eventId));

			const allState = await storage.getAllState(roomId);
			let stateEntries = allState
				.filter((e) => !timelineEventIds.has(e.eventId));

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

			const totalEvents = await storage.getEventsByRoom(
				roomId,
				filter.timelineLimit + 1,
				undefined,
				"b",
			);
			const limited = totalEvents.events.length > filter.timelineLimit;

			const prevBatch =
				limited && result.end !== undefined ? String(result.end) : undefined;

			const notifEvents =
				ignoredUsers.size > 0
					? timelineEvents.filter(
							(e) => !ignoredUsers.has(e.event.sender as UserId),
						)
					: timelineEvents;

			const summary = await buildRoomSummary(storage, roomId, userId);

			join[roomId] = {
				summary,
				state: stateEvents.length > 0 ? { events: stateEvents } : undefined,
				timeline: {
					events: timelineClientEvents,
					limited: limited || undefined,
					prev_batch: prevBatch,
				},
				unread_notifications: await computeNotificationCounts(
					storage,
					roomId,
					userId,
					userRules,
					notifEvents,
				),
			};
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
		}
	}

	const globalData = await storage.getAllGlobalAccountData(userId);
	const accountDataEvents = globalData.map(
		(d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent,
	);

	const seenUsers = new Set<UserId>();
	for (const roomId of Object.keys(join)) {
		const roomData = await storage.getAllRoomAccountData(userId, roomId);
		if (roomData.length > 0) {
			const roomDataEvents = roomData.map(
				(d) => ({ type: d.type, content: d.content }) as unknown as ClientEvent,
			);
			(join[roomId] as JoinedRoom).account_data = { events: roomDataEvents };
		}

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
): Promise<SyncResponse> => {
	const userRooms = await storage.getRoomsForUserWithMembership(userId);

	const join: Record<RoomId, JoinedRoom> = {};
	const invite: Record<RoomId, InvitedRoom> = {};
	const leave: Record<RoomId, LeftRoom> = {};
	const seenUsers = new Set<UserId>();
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

			await bundleAggregations(storage, timelineClientEvents, userId);

			let stateClientEvents: ClientEvent[] = [];
			if (fullState) {
				const allState = await storage.getAllState(roomId);
				const timelineIds = new Set(newEvents.map((e) => e.eventId));
				let stateEntries = allState
					.filter((e) => !timelineIds.has(e.eventId));

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
				const recentResult = await storage.getEventsByRoom(
					roomId,
					filter.timelineLimit,
					undefined,
					"b",
				);
				let recentEvents = recentResult.events.reverse();
				if (ignoredUsers.size > 0) {
					recentEvents = recentEvents.filter(
						(e) => !ignoredUsers.has(e.event.sender),
					);
				}

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
					unread_notifications: await computeNotificationCounts(
						storage,
						roomId,
						userId,
						userRules,
						recentEvents,
					),
				};
			}

			const users = await collectJoinedUsers(storage, roomId);
			for (const u of users) seenUsers.add(u);
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
		} else if (membership === "leave" || membership === "ban") {
			const { events: newEvents, limited } = await storage.getEventsByRoomSince(
				roomId,
				since,
				filter.timelineLimit,
			);
			const membershipChanged = newEvents.some(
				(e) => e.event.type === "m.room.member" && e.event.state_key === userId,
			);
			if (membershipChanged) {
				const timelineClientEvents = newEvents.map((e) =>
					pduToClientEvent(e.event, e.eventId),
				);
				leave[roomId] = {
					timeline: {
						events: timelineClientEvents,
						limited: limited || undefined,
					},
				};
			}
		}
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
		presence:
			presenceEvents.length > 0 ? { events: presenceEvents } : undefined,
		rooms: {
			join: Object.keys(join).length > 0 ? join : undefined,
			invite: Object.keys(invite).length > 0 ? invite : undefined,
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
		const filterParam = req.query.get("filter");

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
				? await buildInitialSync(storage, userId, deviceId, nextBatch, filter)
				: await buildIncrementalSync(
						storage,
						userId,
						deviceId,
						since,
						nextBatch,
						fullState,
						filter,
					);

		return { status: 200, body: response };
	};
