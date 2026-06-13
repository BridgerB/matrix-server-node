import { notFound } from "../errors.ts";
import { contentField, countJoinedMembers, getMembership } from "../events.ts";
import type { FederationClient } from "../federation/client.ts";
import { domainOf } from "../ids.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { SpaceHierarchyRoom } from "../types/directory.ts";
import type { PDU, StrippedStateEvent } from "../types/events.ts";
import type { RoomId, ServerName, UserId } from "../types/index.ts";
import { getAllowedRoomIds } from "./federation/spaces.ts";

const MAX_ROOMS = 50;

type RoomState = NonNullable<Awaited<ReturnType<Storage["getRoom"]>>>;

interface HierarchyRoom extends SpaceHierarchyRoom {
	allowed_room_ids?: string[];
}

type Child = { state: StrippedStateEvent; roomId: RoomId };

const extractChildren = (stateEvents: Map<string, PDU>): Child[] =>
	[...stateEvents]
		.filter(
			([key, event]) =>
				key.startsWith("m.space.child\x1f") &&
				Array.isArray((event.content as Record<string, unknown>).via),
		)
		.map(([, event]) => ({
			state: {
				content: event.content,
				sender: event.sender,
				state_key: event.state_key ?? "",
				type: event.type,
			},
			roomId: (event.state_key ?? "") as RoomId,
		}));

const buildHierarchyRoom = (
	room: RoomState,
	roomId: RoomId,
	childrenState: StrippedStateEvent[],
): HierarchyRoom => {
	const histVis = contentField(
		room.state_events.get("m.room.history_visibility\x1f"),
		"history_visibility",
	);
	const guestAccess = contentField(
		room.state_events.get("m.room.guest_access\x1f"),
		"guest_access",
	);

	return {
		room_id: roomId,
		name: contentField(room.state_events.get("m.room.name\x1f"), "name") as
			| string
			| undefined,
		topic: contentField(room.state_events.get("m.room.topic\x1f"), "topic") as
			| string
			| undefined,
		avatar_url: contentField(
			room.state_events.get("m.room.avatar\x1f"),
			"url",
		) as string | undefined,
		canonical_alias: contentField(
			room.state_events.get("m.room.canonical_alias\x1f"),
			"alias",
		) as string | undefined,
		num_joined_members: countJoinedMembers(room.state_events),
		world_readable: histVis === "world_readable",
		guest_can_join: guestAccess === "can_join",
		join_rule: contentField(
			room.state_events.get("m.room.join_rules\x1f"),
			"join_rule",
		) as string | undefined,
		room_type: contentField(
			room.state_events.get("m.room.create\x1f"),
			"type",
		) as string | undefined,
		children_state: childrenState,
	};
};

/**
 * Whether a local room should be shown to the requesting user. Mirrors
 * Synapse's `_is_local_room_accessible` for the local-requester path.
 */
const isLocalRoomAccessible = async (
	storage: Storage,
	room: RoomState,
	userId: UserId,
): Promise<boolean> => {
	const joinRule = contentField(
		room.state_events.get("m.room.join_rules\x1f"),
		"join_rule",
	);
	if (
		joinRule === "public" ||
		joinRule === "knock" ||
		joinRule === "knock_restricted"
	) {
		return true;
	}

	const histVis = contentField(
		room.state_events.get("m.room.history_visibility\x1f"),
		"history_visibility",
	);
	if (histVis === "world_readable") return true;

	const membership = getMembership(room, userId);
	if (membership === "join" || membership === "invite") return true;

	// Restricted: user is a member of one of the allowed rooms.
	for (const allowedRoomId of getAllowedRoomIds(room)) {
		const allowedRoom = await storage.getRoom(allowedRoomId as RoomId);
		if (allowedRoom && getMembership(allowedRoom, userId) === "join")
			return true;
	}

	return false;
};

/**
 * Whether a room summary received over federation should be shown to the
 * requesting user. Mirrors Synapse's `_is_remote_room_accessible`.
 */
const isRemoteRoomAccessible = async (
	storage: Storage,
	userId: UserId,
	remoteRoom: Record<string, unknown>,
): Promise<boolean> => {
	const joinRule = remoteRoom.join_rule ?? "public";
	if (
		joinRule === "public" ||
		joinRule === "knock" ||
		joinRule === "knock_restricted"
	) {
		return true;
	}
	if (remoteRoom.world_readable === true) return true;

	const allowedRooms = remoteRoom.allowed_room_ids;
	if (Array.isArray(allowedRooms)) {
		for (const allowedRoomId of allowedRooms) {
			if (typeof allowedRoomId !== "string") continue;
			const allowedRoom = await storage.getRoom(allowedRoomId as RoomId);
			if (allowedRoom && getMembership(allowedRoom, userId) === "join")
				return true;
		}
	}

	return false;
};

const remoteToHierarchyRoom = (
	remote: Record<string, unknown>,
): HierarchyRoom => {
	const childrenState = Array.isArray(remote.children_state)
		? (remote.children_state as StrippedStateEvent[])
		: [];
	return {
		room_id: remote.room_id as RoomId,
		name: remote.name as string | undefined,
		topic: remote.topic as string | undefined,
		avatar_url: remote.avatar_url as string | undefined,
		canonical_alias: remote.canonical_alias as string | undefined,
		num_joined_members:
			typeof remote.num_joined_members === "number"
				? remote.num_joined_members
				: 0,
		world_readable: remote.world_readable === true,
		guest_can_join: remote.guest_can_join === true,
		join_rule: remote.join_rule as string | undefined,
		room_type: remote.room_type as string | undefined,
		children_state: childrenState,
	};
};

const stripAllowed = (room: HierarchyRoom): SpaceHierarchyRoom => {
	const { allowed_room_ids: _ignored, ...rest } = room;
	return rest;
};

/**
 * GET /_matrix/client/v1/rooms/:roomId/hierarchy (and /v3)
 *
 * Walks the m.space.child graph rooted at :roomId. Child rooms that live on
 * this server are summarized locally; child rooms on remote servers are fetched
 * via the remote server's /_matrix/federation/v1/hierarchy/:roomId endpoint and
 * merged in. Implements MSC2946 visibility (public / world_readable / member /
 * restricted-membership) for the requesting user.
 */
export const getSpaceHierarchy =
	(
		storage: Storage,
		serverName?: ServerName,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const rootRoomId = req.params.roomId as RoomId;
		const userId = req.userId as UserId;

		const limitStr = req.query.get("limit");
		const limit = Math.min(
			Math.max(parseInt(limitStr ?? String(MAX_ROOMS), 10), 1),
			MAX_ROOMS,
		);
		const maxDepth = Math.max(
			parseInt(req.query.get("max_depth") ?? "50", 10),
			0,
		);
		const suggestedOnly = req.query.get("suggested_only") === "true";
		const from = req.query.get("from") ?? undefined;

		const rootRoom = await storage.getRoom(rootRoomId);
		if (!rootRoom) throw notFound("Room not found");

		const visited = new Set<RoomId>();
		const rooms: SpaceHierarchyRoom[] = [];
		// Depth-first traversal: a LIFO stack. Children are pushed in reverse so
		// they pop in declaration order (matching Synapse/Dendrite pagination).
		const stack: { roomId: RoomId; depth: number; via: ServerName[] }[] = [
			{ roomId: rootRoomId, depth: 0, via: [] },
		];

		let skipping = from !== undefined;

		const localServer = serverName;

		// Summaries for remote rooms returned as `children` of a previously
		// fetched remote room. Lets us render a remote room without re-querying
		// federation (and reach rooms only the remote server knows about).
		const remoteCache = new Map<RoomId, Record<string, unknown>>();

		while (stack.length > 0 && rooms.length < limit) {
			const item = stack.pop();
			if (!item) continue;
			const { roomId, depth, via } = item;
			if (visited.has(roomId)) continue;
			visited.add(roomId);

			const roomServer = domainOf(roomId);
			const isLocal = localServer === undefined || roomServer === localServer;

			let entry: HierarchyRoom | undefined;
			let childItems: { roomId: RoomId; via: ServerName[] }[] = [];

			const localRoom = await storage.getRoom(roomId);

			if (localRoom) {
				// We participate in (or otherwise know) this room locally.
				if (
					roomId !== rootRoomId &&
					!(await isLocalRoomAccessible(storage, localRoom, userId))
				) {
					continue;
				}
				const children = suggestedOnly
					? extractChildren(localRoom.state_events).filter(
							(c) => (c.state.content as Record<string, unknown>).suggested,
						)
					: extractChildren(localRoom.state_events);
				entry = buildHierarchyRoom(
					localRoom,
					roomId,
					children.map((c) => c.state),
				);
				childItems = children.map((c) => ({
					roomId: c.roomId,
					via: extractViaForChild(localRoom.state_events, c.roomId),
				}));
			} else if (!isLocal && (federationClient || remoteCache.has(roomId))) {
				let remoteRoom = remoteCache.get(roomId);
				if (!remoteRoom && federationClient && localServer) {
					// Fetch the remote server's view of this room.
					const remote = await fetchRemoteHierarchy(
						federationClient,
						via,
						roomId,
						suggestedOnly,
					);
					if (remote) {
						remoteRoom = remote.room as Record<string, unknown>;
						for (const child of remote.children) {
							if (child && typeof child === "object") {
								const c = child as Record<string, unknown>;
								if (typeof c.room_id === "string")
									remoteCache.set(c.room_id as RoomId, c);
							}
						}
					}
				}
				if (!remoteRoom) continue;
				if (
					roomId !== rootRoomId &&
					!(await isRemoteRoomAccessible(storage, userId, remoteRoom))
				) {
					continue;
				}
				entry = remoteToHierarchyRoom(remoteRoom);
				childItems = (entry.children_state ?? []).map((cs) => {
					const content = cs.content as Record<string, unknown>;
					const cVia = Array.isArray(content.via)
						? (content.via as ServerName[])
						: [];
					return { roomId: cs.state_key as RoomId, via: cVia };
				});
			} else {
				// Remote room and we cannot federate: skip.
				continue;
			}

			// Only recurse into the children of space rooms (m.space). Links from
			// non-space rooms are returned in children_state but not traversed.
			const isSpace = entry.room_type === "m.space";

			const pushChildren = () => {
				if (!isSpace || depth >= maxDepth) return;
				for (let i = childItems.length - 1; i >= 0; i--) {
					const c = childItems[i]!;
					stack.push({ roomId: c.roomId, depth: depth + 1, via: c.via });
				}
			};

			if (skipping) {
				if (roomId === from) skipping = false;
				pushChildren();
				continue;
			}

			rooms.push(stripAllowed(entry));

			pushChildren();
		}

		const nextBatch =
			stack.length > 0 && rooms.length === limit
				? rooms[rooms.length - 1]?.room_id
				: undefined;

		return {
			status: 200,
			body: { rooms, next_batch: nextBatch },
		};
	};

const extractViaForChild = (
	stateEvents: Map<string, PDU>,
	childRoomId: RoomId,
): ServerName[] => {
	const event = stateEvents.get(`m.space.child\x1f${childRoomId}`);
	if (!event) return [];
	const via = (event.content as Record<string, unknown>).via;
	return Array.isArray(via) ? (via as ServerName[]) : [];
};

const fetchRemoteHierarchy = async (
	client: FederationClient,
	via: ServerName[],
	roomId: RoomId,
	suggestedOnly: boolean,
): Promise<{ room: unknown; children: unknown[] } | undefined> => {
	const path = `/_matrix/federation/v1/hierarchy/${encodeURIComponent(roomId)}${
		suggestedOnly ? "?suggested_only=true" : ""
	}`;
	for (const server of via) {
		try {
			const res = await client.request(server, "GET", path);
			if (res.status === 200 && res.body && typeof res.body === "object") {
				const body = res.body as { room?: unknown; children?: unknown };
				if (body.room) {
					return {
						room: body.room,
						children: Array.isArray(body.children) ? body.children : [],
					};
				}
			}
		} catch {
			// Try the next via server.
		}
	}
	return undefined;
};
