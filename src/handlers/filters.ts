import { badJson, forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";
import type { JsonObject, JsonValue } from "../types/json.ts";

const isObject = (v: JsonValue | undefined): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: JsonValue): boolean =>
	Array.isArray(v) && v.every((item) => typeof item === "string");

/**
 * Validate a room event filter's list-typed fields. These fields
 * (rooms/not_rooms/senders/not_senders/types/not_types) must all be
 * arrays of strings. Sender/room fields additionally must contain
 * properly-sigiled identifiers.
 */
function validateRoomEventFilter(filter: JsonObject, label: string): void {
	const listFields = [
		"rooms",
		"not_rooms",
		"senders",
		"not_senders",
		"types",
		"not_types",
	];
	for (const field of listFields) {
		const value = filter[field];
		if (value === undefined) continue;
		if (!isStringArray(value)) {
			throw badJson(`'${label}.${field}' must be a list of strings`);
		}
		const arr = value as string[];
		if (field === "rooms" || field === "not_rooms") {
			for (const id of arr) {
				if (!id.startsWith("!")) {
					throw badJson(`'${label}.${field}' must contain room IDs`);
				}
			}
		}
		if (field === "senders" || field === "not_senders") {
			for (const id of arr) {
				if (!id.startsWith("@")) {
					throw badJson(`'${label}.${field}' must contain user IDs`);
				}
			}
		}
	}
}

/**
 * Validate the top-level filter object per the Matrix spec. Throws
 * M_BAD_JSON (400) on any malformed field.
 */
function validateFilter(filter: JsonObject): void {
	for (const field of ["presence", "account_data", "room"]) {
		const value = filter[field];
		if (value !== undefined && !isObject(value)) {
			throw badJson(`'${field}' must be an object`);
		}
	}

	if (isObject(filter.presence)) {
		validateRoomEventFilter(filter.presence, "presence");
	}

	const room = filter.room;
	if (isObject(room)) {
		for (const field of ["state", "timeline", "ephemeral", "account_data"]) {
			const value = room[field];
			if (value !== undefined && !isObject(value)) {
				throw badJson(`'room.${field}' must be an object`);
			}
			if (isObject(value)) {
				validateRoomEventFilter(value, `room.${field}`);
			}
		}
	}
}

export const postCreateFilter =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot create filters for another user");

		if (!isObject(req.body as JsonValue)) {
			throw badJson("Filter must be a JSON object");
		}
		const filter = req.body as JsonObject;
		validateFilter(filter);

		const filterId = await storage.createFilter(userId, filter);
		return { status: 200, body: { filter_id: filterId } };
	};

export const getFilterById =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot access another user's filters");

		const filterId = req.params.filterId as string;
		const filter = await storage.getFilter(userId, filterId);
		if (!filter) throw notFound("Filter not found");
		return { status: 200, body: filter };
	};
