import { badJson, invalidParam, missingParam, notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type {
	RoomAlias,
	ServerName,
	Timestamp,
	UserId,
} from "../../types/index.ts";
import { buildPublicRoomEntry } from "../directory.ts";

/**
 * Validates that a string is a well-formed Matrix server name:
 * a hostname (DNS name, IPv4, or [IPv6]) with an optional numeric port.
 * Per the spec, a port — if present — must be a decimal number (1-65535).
 * e.g. "localhost", "example.com:8448" are valid; "localhost:http" is not.
 */
const isValidPort = (port: string): boolean =>
	/^[0-9]+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;

/** Split a server name into its host and optional port, or undefined if malformed. */
const splitServerName = (
	serverName: string,
): { host: string; port?: string } | undefined => {
	if (serverName.startsWith("[")) {
		// IPv6 literal: [::1] or [::1]:8448
		const closeIdx = serverName.indexOf("]");
		if (closeIdx === -1) return undefined;
		const host = serverName.slice(1, closeIdx);
		const rest = serverName.slice(closeIdx + 1);
		if (rest.length > 0 && !rest.startsWith(":")) return undefined;
		return host.length === 0
			? undefined
			: { host, port: rest.length > 0 ? rest.slice(1) : undefined };
	}

	const colonIdx = serverName.lastIndexOf(":");
	const host = colonIdx === -1 ? serverName : serverName.slice(0, colonIdx);
	const port = colonIdx === -1 ? undefined : serverName.slice(colonIdx + 1);
	// Hostname / IPv4: allow letters, digits, '-', '.'
	if (host.length === 0 || !/^[a-zA-Z0-9.-]+$/.test(host)) return undefined;
	return { host, port };
};

const isValidServerName = (serverName: string): boolean => {
	if (serverName.length === 0) return false;
	const parts = splitServerName(serverName);
	if (!parts) return false;
	return parts.port === undefined || isValidPort(parts.port);
};

export const getQueryProfile =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.query.get("user_id");
		if (!userId)
			throw missingParam(
				"The request body did not contain required argument 'user_id'.",
			);

		// User IDs are "@localpart:server_name". Validate the structure and
		// that the server_name portion is well-formed (e.g. reject non-numeric
		// ports like "@user:localhost:http").
		const colonIdx = userId.indexOf(":");
		if (!userId.startsWith("@") || colonIdx === -1)
			throw invalidParam(`Invalid user ID: ${userId}`);
		const serverName = userId.slice(colonIdx + 1);
		if (!isValidServerName(serverName))
			throw invalidParam(`Invalid user ID: ${userId}`);

		const profile = await storage.getProfile(userId as UserId);
		if (!profile)
			throw notFound("The user does not exist or does not have a profile.");

		const field = req.query.get("field");
		if (field !== null && field !== "displayname" && field !== "avatar_url")
			throw invalidParam(
				"The request body did not contain an allowed value of argument 'field'. Allowed values are either: 'avatar_url', 'displayname'.",
			);

		if (field === "displayname")
			return { status: 200, body: { displayname: profile.displayname } };
		if (field === "avatar_url")
			return { status: 200, body: { avatar_url: profile.avatar_url } };

		return {
			status: 200,
			body: {
				displayname: profile.displayname,
				avatar_url: profile.avatar_url,
			},
		};
	};

export const getQueryDirectory =
	(storage: Storage): Handler =>
	async (req) => {
		// `room_alias` arrives URL-decoded here: the router parses the request URL
		// with `new URL(...)` and exposes `req.query` as URLSearchParams, which
		// decodes percent-escapes (including multi-byte UTF-8 sequences). So a
		// unicode alias such as "#老虎🤨:hs1" is already fully decoded by this point.
		const roomAlias = req.query.get("room_alias") as RoomAlias | null;
		if (!roomAlias) throw badJson("Must supply room alias parameter.");

		// Aliases must be "#localpart:domain". Validate the structure so we reject
		// malformed input with M_BAD_JSON rather than treating it as a lookup miss.
		const colonIdx = roomAlias.indexOf(":");
		if (!roomAlias.startsWith("#") || colonIdx === -1 || colonIdx === 1)
			throw badJson("Room alias must be in the form '#localpart:domain'");

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound(`Room alias ${roomAlias} not found`);

		// Ensure our own server name appears in the returned server list so the
		// requesting homeserver knows it can reach the room via us.
		const servers =
			result.servers && result.servers.length > 0
				? result.servers
				: [roomAlias.slice(colonIdx + 1) as ServerName];

		return {
			status: 200,
			body: {
				room_id: result.room_id,
				servers,
			},
		};
	};

export const getFederationPublicRooms =
	(storage: Storage): Handler =>
	async (_req) => {
		const publicRoomIds = await storage.getPublicRoomIds();
		const rooms = (
			await Promise.all(
				publicRoomIds.map((roomId) => buildPublicRoomEntry(storage, roomId)),
			)
		).filter(Boolean);

		return {
			status: 200,
			body: { chunk: rooms, total_room_count_estimate: rooms.length },
		};
	};

export const postFederationPublicRooms =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			limit?: number;
			since?: string;
			filter?: { generic_search_term?: string };
		};

		const limit = Math.min(body.limit ?? 100, 100);
		const publicRoomIds = await storage.getPublicRoomIds();
		const allRooms = (
			await Promise.all(
				publicRoomIds.map((roomId) => buildPublicRoomEntry(storage, roomId)),
			)
		).filter(Boolean);

		const searchTerm = body.filter?.generic_search_term?.toLowerCase();
		const filtered = searchTerm
			? allRooms.filter((r) => {
					if (!r) return false;
					return (
						r.name?.toLowerCase().includes(searchTerm) ||
						r.topic?.toLowerCase().includes(searchTerm)
					);
				})
			: allRooms;

		const startIdx = body.since ? parseInt(body.since, 10) : 0;
		const chunk = filtered.slice(startIdx, startIdx + limit);
		const nextBatch =
			startIdx + limit < filtered.length ? String(startIdx + limit) : undefined;

		return {
			status: 200,
			body: {
				chunk,
				next_batch: nextBatch,
				total_room_count_estimate: filtered.length,
			},
		};
	};

export const getFederationVersion = (): Handler => () => ({
	status: 200,
	body: {
		server: {
			name: "strix",
			version: "0.0.1",
		},
	},
});

export const getQueryGeneric = (): Handler => (_req) => ({
	status: 200,
	body: {},
});

export const getFederationOpenIdUserinfo =
	(storage: Storage): Handler =>
	async (req) => {
		const accessToken = req.query.get("access_token");
		if (!accessToken) throw notFound("Missing access_token");

		const result = await storage.getOpenIdToken(accessToken);
		if (!result) throw notFound("Token not found");

		if (result.expiresAt <= (Date.now() as Timestamp))
			throw notFound("Token expired");

		return {
			status: 200,
			body: { sub: result.userId },
		};
	};
