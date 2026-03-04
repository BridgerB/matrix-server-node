import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, UserId } from "../types/index.ts";
import type { SearchRequest, SearchResult } from "../types/room-operations.ts";
import type { ClientEvent } from "../types/events.ts";
import { pduToClientEvent } from "../events.ts";
import { badJson } from "../errors.ts";
import { bundleAggregations } from "../relations.ts";

// =============================================================================
// POST /_matrix/client/v3/search
// =============================================================================

export function postSearch(storage: Storage): Handler {
	return async (req) => {
		const userId = req.userId!;
		const body = (req.body ?? {}) as SearchRequest;

		const roomEvents = body.search_categories?.room_events;
		if (!roomEvents?.search_term)
			throw badJson("Missing search_categories.room_events.search_term");

		const searchTerm = roomEvents.search_term;
		const keys = roomEvents.keys ?? ["content.body"];
		const orderBy = roomEvents.order_by ?? "recent";
		const limit = 10;
		const from = req.query.get("next_batch") ?? undefined;

		// Determine rooms to search
		const joinedRooms = await storage.getRoomsForUser(userId);
		let roomIds: RoomId[] = joinedRooms;
		if (roomEvents.filter?.rooms) {
			const filterRooms = new Set(
				roomEvents.filter.rooms as unknown as RoomId[],
			);
			roomIds = joinedRooms.filter((r) => filterRooms.has(r));
		}

		const searchResult = await storage.searchRoomEvents(
			roomIds,
			searchTerm,
			keys,
			limit,
			from,
		);

		// Build search results with optional context
		const beforeLimit = roomEvents.event_context?.before_limit ?? 5;
		const afterLimit = roomEvents.event_context?.after_limit ?? 5;
		const includeProfile = roomEvents.event_context?.include_profile ?? false;
		const includeState = roomEvents.include_state ?? false;

		const results: SearchResult[] = [];
		const stateMap: Record<RoomId, ClientEvent[]> = {};
		const highlights = extractHighlights(searchTerm);

		for (const { event, eventId, streamPos } of searchResult.events) {
			const clientEvent = pduToClientEvent(event, eventId);

			const searchResultEntry: SearchResult = {
				rank: orderBy === "rank" ? 1.0 : streamPos,
				result: clientEvent,
			};

			// Add context if requested
			if (roomEvents.event_context) {
				const beforeResult = await storage.getEventsByRoom(
					event.room_id,
					beforeLimit,
					streamPos,
					"b",
				);
				const afterResult = await storage.getEventsByRoom(
					event.room_id,
					afterLimit,
					streamPos,
					"f",
				);

				const eventsBefore = beforeResult.events.map((e) =>
					pduToClientEvent(e.event, e.eventId),
				);
				const eventsAfter = afterResult.events.map((e) =>
					pduToClientEvent(e.event, e.eventId),
				);

				const context: SearchResult["context"] = {
					events_before: eventsBefore,
					events_after: eventsAfter,
				};

				if (includeProfile) {
					const profileInfo: Record<
						UserId,
						{ displayname?: string; avatar_url?: string }
					> = {};
					const allSenders = new Set<UserId>([
						event.sender,
						...eventsBefore.map((e) => e.sender),
						...eventsAfter.map((e) => e.sender),
					]);
					for (const sender of allSenders) {
						const profile = await storage.getProfile(sender);
						if (profile) {
							profileInfo[sender] = {
								displayname: profile.displayname,
								avatar_url: profile.avatar_url,
							};
						}
					}
					context.profile_info = profileInfo;
				}

				searchResultEntry.context = context;
			}

			results.push(searchResultEntry);

			// Collect state if requested
			if (includeState && !stateMap[event.room_id]) {
				const allState = await storage.getAllState(event.room_id);
				stateMap[event.room_id] = allState.map((e) =>
					pduToClientEvent(e.event, e.eventId),
				);
			}
		}

		// Bundle aggregations on result events
		const allResultEvents = results.map((r) => r.result);
		await bundleAggregations(storage, allResultEvents, userId);

		// Build groupings if requested
		let groups:
			| Record<string, Record<string, { results: string[]; order: number }>>
			| undefined;
		if (roomEvents.groupings?.group_by) {
			groups = {};
			for (const grouping of roomEvents.groupings.group_by) {
				const groupKey = grouping.key;
				const groupMap: Record<string, { results: string[]; order: number }> =
					{};

				for (let i = 0; i < results.length; i++) {
					const result = results[i]!;
					const key =
						groupKey === "room_id"
							? result.result.room_id!
							: result.result.sender;

					if (!groupMap[key]) {
						groupMap[key] = { results: [], order: i };
					}
					groupMap[key]!.results.push(result.result.event_id);
				}

				groups[groupKey] = groupMap;
			}
		}

		return {
			status: 200,
			body: {
				search_categories: {
					room_events: {
						count: results.length,
						highlights,
						results,
						state:
							includeState && Object.keys(stateMap).length > 0
								? stateMap
								: undefined,
						groups,
						next_batch: searchResult.nextBatch,
					},
				},
			},
		};
	};
}

function extractHighlights(searchTerm: string): string[] {
	return searchTerm.split(/\s+/).filter((w) => w.length > 0);
}
