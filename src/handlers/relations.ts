import { createHash } from "node:crypto";
import { forbidden, notFound } from "../errors.ts";
import {
	computeEventId,
	getMembership,
	pduToClientEvent,
	requireJoinedRoom,
} from "../events.ts";
import type { FederationClient } from "../federation/client.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ClientEvent, PDU } from "../types/events.ts";
import type {
	EventId,
	RoomId,
	ServerName,
} from "../types/identifiers.ts";

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
// MSC2836 — Relationship based threading
// https://github.com/matrix-org/matrix-spec-proposals/pull/2836
//
// Two endpoints:
//   - POST /_matrix/client/unstable/event_relationships          (client, auth)
//   - POST /_matrix/federation/unstable/event_relationships      (server, fedAuth)
//
// Both walk the m.relationship graph (rel_type "m.reference") starting from a
// root event, returning events in DAG-walk order. Mirrors element-hq/dendrite's
// setup/mscs/msc2836/msc2836.go (process / walkThread / walker.WalkFrom).
//
// The client endpoint, when it encounters an event (or children) it does not
// hold locally, "spiders" the thread by issuing a federation
// /event_relationships request to a server in the room and persisting the
// returned events (dendrite: fetchUnknownEvent / lookForEvent /
// remoteEventRelationships / injectResponseToRoomserver). The federation
// endpoint never spiders further — it only answers from local state and
// additionally returns the auth_chain of the returned events.
//
// NOTE: relations are NOT indexed into a dedicated table in this codebase, so
// we build the parent<->child graph by scanning the room timeline directly and
// parsing each event's `m.relationship` content. Children are ordered by
// origin_server_ts (matching dendrite's storage ORDER BY origin_server_ts).
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

/**
 * Build the relation graph for a room by scanning its timeline. When `roomId`
 * is undefined (the client requested an event we don't yet hold and gave no
 * room_id) an empty graph is returned, to be populated lazily by remote fetches.
 */
const buildGraphForRoom = async (
	storage: Storage,
	roomId: RoomId | undefined,
): Promise<RelationGraph> => {
	const graph: RelationGraph = {
		children: new Map(),
		parent: new Map(),
		byId: new Map(),
	};
	if (!roomId) return graph;

	const streamPos = await storage.getStreamPosition();
	// Fetch the whole timeline in stream (ascending) order.
	const { events } = await storage.getEventsByRoom(
		roomId,
		streamPos + 1,
		0,
		"f",
	);
	for (const e of events) indexIntoGraph(graph, e);
	return graph;
};

/**
 * Children of an event for the given rel_type, ordered per recent_first.
 * Mirrors dendrite storage.go: ORDER BY origin_server_ts (ASC oldest-first,
 * DESC recent-first), with event_id as a deterministic tie-breaker.
 */
const childrenForParent = (
	graph: RelationGraph,
	eventId: EventId,
	recentFirst: boolean,
): { event: PDU; eventId: EventId }[] => {
	const list = (graph.children.get(eventId) ?? []).filter(
		(c) => graph.parent.get(c.eventId)?.relType === REL_TYPE,
	);
	const sorted = [...list].sort((a, b) => {
		const ta = a.event.origin_server_ts;
		const tb = b.event.origin_server_ts;
		if (ta !== tb) return ta - tb; // ascending (oldest first)
		return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
	});
	return recentFirst ? sorted.reverse() : sorted;
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

// The DAG walk itself lives inline in processRelationships below, because it
// must be able to `await` remote fetches when it visits an event we don't hold
// locally (dendrite's walker.WalkFrom + lookForEvent). It is a breadth-first
// (queue) or depth-first (stack) traversal honouring max_depth / max_breadth.

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

interface RelationshipRequest {
	eventId: EventId;
	roomId?: RoomId;
	limit: number;
	maxBreadth: number;
	maxDepth: number;
	depthFirst: boolean;
	recentFirst: boolean;
	includeParent: boolean;
	includeChildren: boolean;
	direction: "up" | "down";
}

/** Parse a request body applying MSC2836 / dendrite Defaults(). */
const parseRequest = (raw: unknown): RelationshipRequest => {
	const body = (raw ?? {}) as {
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
	return {
		eventId: body.event_id as EventId,
		roomId: body.room_id as RoomId | undefined,
		limit: body.limit ?? 100,
		maxBreadth: body.max_breadth ?? 10,
		maxDepth: body.max_depth ?? 3,
		depthFirst: body.depth_first ?? false,
		recentFirst: body.recent_first ?? true,
		includeParent: body.include_parent ?? false,
		includeChildren: body.include_children ?? false,
		direction: body.direction === "up" ? "up" : "down",
	};
};

/** Index a single PDU into an in-memory relation graph. */
const indexIntoGraph = (
	graph: RelationGraph,
	entry: { event: PDU; eventId: EventId },
): void => {
	if (!graph.byId.has(entry.eventId)) graph.byId.set(entry.eventId, entry);
	const rel = parentRelationship(entry.event);
	if (!rel) return;
	if (!graph.parent.has(entry.eventId)) graph.parent.set(entry.eventId, rel);
	let list = graph.children.get(rel.parentId);
	if (!list) {
		list = [];
		graph.children.set(rel.parentId, list);
	}
	if (!list.some((c) => c.eventId === entry.eventId)) list.push(entry);
};

/**
 * Issue a federation /event_relationships request to (up to 5) servers in the
 * room and persist every returned event + auth_chain event locally, also
 * indexing them into the working graph. Mirrors dendrite's
 * remoteEventRelationships + injectResponseToRoomserver. Returns the persisted
 * entry for `eventId` if it was among the returned events.
 *
 * No-op (returns undefined) when there is no federation client or room id.
 */
const fetchRemote = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient | undefined,
	roomId: RoomId | undefined,
	eventId: EventId,
	req: RelationshipRequest,
	graph: RelationGraph,
): Promise<{ event: PDU; eventId: EventId } | undefined> => {
	if (!federationClient || !roomId) return undefined;

	const servers = (await storage.getServersInRoom(roomId))
		.filter((s) => s !== serverName)
		.slice(0, 5);

	for (const srv of servers) {
		let res: { status: number; body: unknown };
		try {
			res = await federationClient.request(
				srv,
				"POST",
				"/_matrix/federation/unstable/event_relationships",
				{
					event_id: eventId,
					direction: req.direction,
					limit: req.limit,
					max_breadth: req.maxBreadth,
					max_depth: req.maxDepth,
					depth_first: req.depthFirst,
					recent_first: req.recentFirst,
				},
			);
		} catch {
			continue;
		}
		if (res.status !== 200 || typeof res.body !== "object" || !res.body)
			continue;

		const payload = res.body as {
			events?: PDU[];
			auth_chain?: PDU[];
		};
		// Persist auth chain first so referenced auth events exist, then events.
		for (const ev of payload.auth_chain ?? []) {
			const id = computeEventId(ev);
			if (!(await storage.getEvent(id))) await storage.storeEvent(ev, id);
		}
		let found: { event: PDU; eventId: EventId } | undefined;
		for (const ev of payload.events ?? []) {
			const id = computeEventId(ev);
			const entry = { event: ev, eventId: id };
			if (!(await storage.getEvent(id))) await storage.storeEvent(ev, id);
			indexIntoGraph(graph, entry);
			if (id === eventId) found = entry;
		}
		if (found) return found;
	}
	return undefined;
};

/**
 * Resolve an event by id: return it from the graph if present, otherwise (for
 * client requests with a federation client) spider it in from a remote server.
 * Mirrors dendrite's lookForEvent.
 */
const lookForEvent = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient | undefined,
	roomId: RoomId | undefined,
	eventId: EventId,
	req: RelationshipRequest,
	graph: RelationGraph,
): Promise<{ event: PDU; eventId: EventId } | undefined> => {
	const local = graph.byId.get(eventId);
	if (local) return local;
	return fetchRemote(
		storage,
		serverName,
		federationClient,
		roomId,
		eventId,
		req,
		graph,
	);
};

/**
 * Shared core for both the client and federation handlers. `federationClient`
 * is only supplied (and only used) for client requests — federation requests
 * never spider further (dendrite isFederatedRequest short-circuits).
 */
const processRelationships = async (params: {
	storage: Storage;
	serverName: ServerName;
	req: RelationshipRequest;
	rootEntry: { event: PDU; eventId: EventId };
	roomId: RoomId;
	graph: RelationGraph;
	federationClient?: FederationClient;
}): Promise<{
	returned: { event: PDU; eventId: EventId }[];
	limited: boolean;
}> => {
	const { storage, serverName, req, rootEntry, roomId, graph, federationClient } =
		params;

	const returned: { event: PDU; eventId: EventId }[] = [rootEntry];
	const included = new Set<EventId>([rootEntry.eventId]);

	// include_parent: pull in the directly referenced parent event.
	if (req.includeParent) {
		const rel = graph.parent.get(rootEntry.eventId);
		if (rel && rel.relType === REL_TYPE) {
			const parent = await lookForEvent(
				storage,
				serverName,
				federationClient,
				roomId,
				rel.parentId,
				req,
				graph,
			);
			if (parent && !included.has(parent.eventId)) {
				returned.push(parent);
				included.add(parent.eventId);
			}
		}
	}

	// include_children: pull in the direct children of the root event.
	if (req.includeChildren && returned.length < req.limit) {
		for (const child of childrenForParent(
			graph,
			rootEntry.eventId,
			req.recentFirst,
		)) {
			if (returned.length >= req.limit) break;
			if (included.has(child.eventId)) continue;
			returned.push(child);
			included.add(child.eventId);
		}
	}

	// Walk the DAG from the root in the requested direction, spidering in any
	// events we are missing locally (client requests only). We walk by event id
	// — for "up" walks the parent id is known from the child's m.relationship
	// even before we hold the parent event, so fetching it extends the chain.
	let walkLimited = false;
	if (returned.length < req.limit) {
		const walkReq: WalkRequest = {
			direction: req.direction,
			recentFirst: req.recentFirst,
			depthFirst: req.depthFirst,
			maxDepth: req.maxDepth,
			maxBreadth: req.maxBreadth,
		};

		// Frontier walk that can await remote fetches. Equivalent to walkFrom but
		// resolves each visited node via lookForEvent so the next layer (which may
		// reference not-yet-fetched events) becomes available.
		const toWalk: WalkItem[] = [];
		const seedLayer = walkLayer(graph, rootEntry.eventId, walkReq);
		for (const c of seedLayer.slice(
			0,
			walkReq.maxBreadth >= 0 ? walkReq.maxBreadth : seedLayer.length,
		)) {
			toWalk.push({ eventId: c.eventId, depth: 1 });
		}

		const nextItem = (): WalkItem | undefined =>
			req.depthFirst ? toWalk.pop() : toWalk.shift();

		let item = nextItem();
		while (item) {
			if (included.has(item.eventId)) {
				item = nextItem();
				continue;
			}
			if (returned.length >= req.limit) {
				walkLimited = true;
				break;
			}
			const entry = await lookForEvent(
				storage,
				serverName,
				federationClient,
				roomId,
				item.eventId,
				req,
				graph,
			);
			if (entry) returned.push(entry);
			included.add(item.eventId);

			if (item.depth < req.maxDepth) {
				const layer = walkLayer(graph, item.eventId, walkReq);
				const trimmed =
					walkReq.maxBreadth >= 0 && layer.length > walkReq.maxBreadth
						? layer.slice(0, walkReq.maxBreadth)
						: layer;
				for (const c of trimmed) {
					toWalk.push({ eventId: c.eventId, depth: item.depth + 1 });
				}
			}
			item = nextItem();
		}
	}

	const limited = returned.length >= req.limit || walkLimited;
	return { returned, limited };
};

/**
 * POST /_matrix/client/unstable/event_relationships (authenticated client).
 *
 * Walks the relationship DAG for the requesting (joined) user, spidering in
 * unknown events from remote servers via the federation endpoint when needed.
 */
export const postEventRelationships =
	(
		storage: Storage,
		serverName: ServerName,
		federationClient?: FederationClient,
	): Handler =>
	async (httpReq) => {
		const userId = httpReq.userId as string;
		const req = parseRequest(httpReq.body);
		if (!req.eventId) throw notFound("Missing event_id");

		const graph = await buildGraphForRoom(storage, req.roomId);

		// Resolve the root event: local first, then remote spider (dendrite
		// getLocalEvent -> fetchUnknownEvent).
		let rootEntry =
			graph.byId.get(req.eventId) ?? (await storage.getEvent(req.eventId));
		let roomId = (req.roomId ?? rootEntry?.event.room_id) as RoomId | undefined;
		if (!rootEntry) {
			rootEntry = await fetchRemote(
				storage,
				serverName,
				federationClient,
				roomId,
				req.eventId,
				req,
				graph,
			);
			roomId = (req.roomId ?? rootEntry?.event.room_id) as RoomId | undefined;
		}

		if (!rootEntry || !roomId || rootEntry.event.room_id !== roomId) {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}
		req.roomId = roomId;

		// Authorisation: the user must be joined to the room.
		const room = await storage.getRoom(roomId);
		if (!room || getMembership(room, userId) !== "join") {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}

		const { returned, limited } = await processRelationships({
			storage,
			serverName,
			req,
			rootEntry,
			roomId,
			graph,
			federationClient,
		});

		const events = returned.map((e) => pduToClientEvent(e.event, e.eventId));
		for (const ce of events) addChildMetadata(graph, ce);

		return {
			status: 200,
			body: { events, limited, next_batch: undefined },
		};
	};

/**
 * POST /_matrix/federation/unstable/event_relationships (federation, fedAuth).
 *
 * Answers a remote server's relationship query purely from local state (no
 * further spidering) and additionally returns the auth_chain of the returned
 * events so the caller can authorise and persist them. Mirrors dendrite's
 * federatedEventRelationship.
 */
export const postFederationEventRelationships =
	(
		storage: Storage,
		serverName: ServerName,
		_federationClient?: FederationClient,
	): Handler =>
	async (httpReq) => {
		const origin = httpReq.origin as ServerName;
		const req = parseRequest(httpReq.body);
		if (!req.eventId) throw notFound("Missing event_id");

		const rootEntry = await storage.getEvent(req.eventId);
		const roomId = (req.roomId ?? rootEntry?.event.room_id) as
			| RoomId
			| undefined;

		if (!rootEntry || !roomId || rootEntry.event.room_id !== roomId) {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}
		req.roomId = roomId;

		// Authorisation: the origin server must be joined to the room.
		const servers = await storage.getServersInRoom(roomId);
		if (!servers.includes(origin)) {
			throw forbidden(
				"Event does not exist or you are not authorised to see it",
			);
		}

		const graph = await buildGraphForRoom(storage, roomId);

		// Federation requests never spider further: omit the federation client.
		const { returned, limited } = await processRelationships({
			storage,
			serverName,
			req,
			rootEntry,
			roomId,
			graph,
		});

		// Attach child metadata onto the federation PDUs' unsigned data so the
		// caller can detect unexplored children.
		const events = returned.map((e) => {
			const ce = pduToClientEvent(e.event, e.eventId);
			addChildMetadata(graph, ce);
			return { ...e.event, unsigned: ce.unsigned };
		});

		// auth_chain: the auth chain of every returned event's auth_events
		// (dendrite QueryAuthChain over the union of AuthEventIDs).
		const authEventIds = new Set<EventId>();
		for (const e of returned) {
			for (const id of e.event.auth_events) authEventIds.add(id as EventId);
		}
		const authChain =
			authEventIds.size > 0
				? await storage.getAuthChain([...authEventIds])
				: [];

		return {
			status: 200,
			body: {
				events,
				auth_chain: authChain,
				limited,
				next_batch: undefined,
			},
		};
	};
