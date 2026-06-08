import { createHash } from "node:crypto";
import { forbidden, notFound } from "../errors.ts";
import { getMembership, pduToClientEvent, requireJoinedRoom } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ClientEvent, PDU } from "../types/events.ts";
import type { EventId, RoomId } from "../types/identifiers.ts";

export const getRelations =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;
		const relType = req.params.relType;
		const eventType = req.params.eventType;
		const userId = req.userId as string;

		await requireJoinedRoom(storage, roomId, userId);

		const target = await storage.getEvent(eventId);
		if (!target || target.event.room_id !== roomId)
			throw notFound("Event not found");

		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10), 1), 100);
		const from = req.query.get("from") ?? undefined;
		const dir = (req.query.get("dir") ?? "b") as "b" | "f";

		const result = await storage.getRelatedEvents(
			roomId,
			eventId,
			relType,
			eventType,
			limit,
			from,
			dir,
		);
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);

		await bundleAggregations(storage, chunk, userId);

		return {
			status: 200,
			body: {
				chunk,
				next_batch: result.nextBatch,
			},
		};
	};

// ---------------------------------------------------------------------------
// MSC2836 — POST /_matrix/client/unstable/event_relationships
// https://github.com/matrix-org/matrix-spec-proposals/pull/2836
//
// Walks the m.relationship graph (rel_type "m.reference") starting from a root
// event, returning events in DAG-walk order. Mirrors element-hq/dendrite's
// setup/mscs/msc2836/msc2836.go (process / walkThread / walker.WalkFrom) and
// matrix-org/synapse's threading handler.
//
// NOTE: relations are NOT indexed into the storage `relations` table in this
// codebase (indexRelation is never wired into the event-store flow, and only
// reads `m.relates_to`, not the MSC2836 `m.relationship` field). So we build
// the parent<->child graph by scanning the room timeline directly and parsing
// each event's `m.relationship` content. No federation spidering is performed
// (see route/risk notes in the accompanying report).
// ---------------------------------------------------------------------------

const REL_TYPE = "m.reference";

interface RelationshipInfo {
	parentId: EventId;
	relType: string;
}

/** Extract the MSC2836 m.relationship parent reference from an event. */
const parentRelationship = (event: PDU): RelationshipInfo | undefined => {
	const content = event.content as Record<string, unknown>;
	// Prefer MSC2836's m.relationship; fall back to the stable m.relates_to.
	const rel = (content["m.relationship"] ?? content["m.relates_to"]) as
		| { rel_type?: string; event_id?: string }
		| undefined;
	if (!rel?.rel_type || !rel?.event_id) return undefined;
	return { parentId: rel.event_id as EventId, relType: rel.rel_type };
};

interface RelationGraph {
	/** parent event id -> child events, in ascending stream order */
	children: Map<EventId, { event: PDU; eventId: EventId }[]>;
	/** child event id -> parent reference */
	parent: Map<EventId, RelationshipInfo>;
	/** all events keyed by id */
	byId: Map<EventId, { event: PDU; eventId: EventId }>;
}

/** Build the relation graph for a room by scanning its timeline. */
const buildRelationGraph = async (
	storage: Storage,
	roomId: RoomId,
): Promise<RelationGraph> => {
	const streamPos = await storage.getStreamPosition();
	// Fetch the whole timeline in stream (ascending) order.
	const { events } = await storage.getEventsByRoom(
		roomId,
		streamPos + 1,
		0,
		"f",
	);

	const children: RelationGraph["children"] = new Map();
	const parent: RelationGraph["parent"] = new Map();
	const byId: RelationGraph["byId"] = new Map();

	for (const e of events) {
		byId.set(e.eventId, e);
		const rel = parentRelationship(e.event);
		if (!rel) continue;
		parent.set(e.eventId, rel);
		let list = children.get(rel.parentId);
		if (!list) {
			list = [];
			children.set(rel.parentId, list);
		}
		list.push(e);
	}

	return { children, parent, byId };
};

/** Children of an event for the given rel_type, ordered per recent_first. */
const childrenForParent = (
	graph: RelationGraph,
	eventId: EventId,
	recentFirst: boolean,
): { event: PDU; eventId: EventId }[] => {
	const list = (graph.children.get(eventId) ?? []).filter(
		(c) => graph.parent.get(c.eventId)?.relType === REL_TYPE,
	);
	// list is in ascending stream order (oldest first). recent_first reverses it.
	const ordered = recentFirst ? [...list].reverse() : list;
	return ordered;
};

interface WalkRequest {
	direction: "up" | "down";
	recentFirst: boolean;
	depthFirst: boolean;
	maxDepth: number;
	maxBreadth: number;
}

interface WalkItem {
	eventId: EventId;
	depth: number;
}

/**
 * Returns the next layer for the walk: for direction "down" the children of
 * the event, for direction "up" the (single) parent.
 */
const walkLayer = (
	graph: RelationGraph,
	eventId: EventId,
	req: WalkRequest,
): { event: PDU; eventId: EventId }[] => {
	if (req.direction === "down") {
		return childrenForParent(graph, eventId, req.recentFirst);
	}
	const rel = graph.parent.get(eventId);
	if (!rel || rel.relType !== REL_TYPE) return [];
	const parent = graph.byId.get(rel.parentId);
	return parent ? [parent] : [];
};

/**
 * Walk the relation DAG from rootId (exclusive), invoking fn for each event.
 * Mirrors dendrite's walker.WalkFrom: breadth-first (queue) or depth-first
 * (stack), honouring max_depth and max_breadth. fn returns true to terminate
 * (which marks the response as limited).
 */
const walkFrom = (
	graph: RelationGraph,
	rootId: EventId,
	req: WalkRequest,
	fn: (item: WalkItem) => boolean,
): boolean => {
	const addLayer = (
		toWalk: WalkItem[],
		layer: { event: PDU; eventId: EventId }[],
		depth: number,
	): void => {
		if (depth > req.maxDepth) return;
		let trimmed = layer;
		if (req.maxBreadth >= 0 && trimmed.length > req.maxBreadth) {
			trimmed = trimmed.slice(0, req.maxBreadth);
		}
		for (const c of trimmed) {
			toWalk.push({ eventId: c.eventId, depth });
		}
	};

	const nextChild = (toWalk: WalkItem[]): WalkItem | undefined => {
		if (toWalk.length === 0) return undefined;
		return req.depthFirst ? toWalk.pop() : toWalk.shift();
	};

	const toWalk: WalkItem[] = [];
	addLayer(toWalk, walkLayer(graph, rootId, req), 1);

	let next = nextChild(toWalk);
	while (next) {
		if (fn(next)) return true;
		addLayer(toWalk, walkLayer(graph, next.eventId, req), next.depth + 1);
		next = nextChild(toWalk);
	}
	return false;
};

/**
 * Compute MSC2836 child metadata (unsigned.children counts and
 * unsigned.children_hash) for an event and attach it to the client event.
 */
const addChildMetadata = (
	graph: RelationGraph,
	clientEvent: ClientEvent,
): void => {
	const kids = childrenForParent(graph, clientEvent.event_id, false);
	if (kids.length === 0) return;

	const ids = kids.map((k) => k.eventId).sort();
	// MSC2836 children_hash is unpadded *standard* base64 (RawStdEncoding in the
	// Complement test), not base64url.
	const hash = createHash("sha256")
		.update(ids.join(""))
		.digest("base64")
		.replace(/=+$/, "");

	const unsigned = (clientEvent.unsigned ?? {}) as Record<string, unknown>;
	unsigned["children"] = { [REL_TYPE]: kids.length };
	unsigned["children_hash"] = hash;
	clientEvent.unsigned = unsigned as ClientEvent["unsigned"];
};

export const postEventRelationships =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const body = (req.body ?? {}) as {
			event_id?: string;
			room_id?: string;
			max_depth?: number;
			max_breadth?: number;
			limit?: number;
			depth_first?: boolean;
			recent_first?: boolean;
			include_parent?: boolean;
			include_children?: boolean;
			direction?: string;
		};

		const rootEventId = body.event_id as EventId | undefined;
		if (!rootEventId) throw notFound("Missing event_id");

		// MSC2836 defaults (matching dendrite EventRelationshipRequest.Defaults).
		const limit = body.limit ?? 100;
		const maxBreadth = body.max_breadth ?? 10;
		const maxDepth = body.max_depth ?? 3;
		const depthFirst = body.depth_first ?? false;
		const recentFirst = body.recent_first ?? true;
		const includeParent = body.include_parent ?? false;
		const includeChildren = body.include_children ?? false;
		const direction = body.direction === "up" ? "up" : "down";

		const rootEntry = await storage.getEvent(rootEventId);
		if (!rootEntry) {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}
		const roomId = (body.room_id ?? rootEntry.event.room_id) as RoomId;
		if (rootEntry.event.room_id !== roomId) {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}

		// Authorisation: the user must be joined to the room.
		const room = await storage.getRoom(roomId);
		if (!room || getMembership(room, userId) !== "join") {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}

		const graph = await buildRelationGraph(storage, roomId);

		const walkReq: WalkRequest = {
			direction,
			recentFirst,
			depthFirst,
			maxDepth,
			maxBreadth,
		};

		const returned: { event: PDU; eventId: EventId }[] = [rootEntry];
		const included = new Set<EventId>([rootEventId]);

		// include_parent: pull in the directly referenced parent event.
		if (includeParent) {
			const rel = graph.parent.get(rootEventId);
			if (rel && rel.relType === REL_TYPE) {
				const parent = graph.byId.get(rel.parentId);
				if (parent && !included.has(parent.eventId)) {
					returned.push(parent);
					included.add(parent.eventId);
				}
			}
		}

		// include_children: pull in the direct children of the root event.
		if (includeChildren && returned.length < limit) {
			for (const child of childrenForParent(
				graph,
				rootEventId,
				recentFirst,
			)) {
				if (returned.length >= limit) break;
				if (included.has(child.eventId)) continue;
				returned.push(child);
				included.add(child.eventId);
			}
		}

		// Walk the DAG from the root in the requested direction.
		let walkLimited = false;
		if (returned.length < limit) {
			walkLimited = walkFrom(graph, rootEventId, walkReq, (item) => {
				if (included.has(item.eventId)) return false;
				if (returned.length >= limit) return true;
				const entry = graph.byId.get(item.eventId);
				if (entry) returned.push(entry);
				included.add(item.eventId);
				return false;
			});
		}

		const limited = returned.length >= limit || walkLimited;

		const events = returned.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		for (const ce of events) {
			addChildMetadata(graph, ce);
		}

		return {
			status: 200,
			body: {
				events,
				limited,
				next_batch: undefined,
			},
		};
	};
