import { badJson, forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

const FORBIDDEN_TYPES = new Set(["m.fully_read", "m.push_rules"]);

/** True if the parsed body is an empty JSON object `{}`. */
function isEmptyObject(body: unknown): boolean {
	return (
		typeof body === "object" &&
		body !== null &&
		!Array.isArray(body) &&
		Object.keys(body as Record<string, unknown>).length === 0
	);
}

export const getGlobalAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot access another user's account data");

		const type = req.params.type as string;
		const data = await storage.getGlobalAccountData(userId, type);
		// MSC3391: a deleted entry is stored as an empty-object tombstone; treat it
		// as absent for GET (404).
		if (!data || isEmptyObject(data)) throw notFound("Account data not found");
		return { status: 200, body: data };
	};

export const putGlobalAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot set another user's account data");

		const type = req.params.type as string;
		if (FORBIDDEN_TYPES.has(type))
			throw badJson(`Cannot set ${type} via this endpoint`);

		const content = req.body as JsonObject;
		// MSC3391: PUT with an empty content dictionary is equivalent to deleting
		// the account data type, so a subsequent GET returns 404.
		if (isEmptyObject(content)) {
			await storage.deleteGlobalAccountData(userId, type);
			return { status: 200, body: {} };
		}
		await storage.setGlobalAccountData(userId, type, content);
		return { status: 200, body: {} };
	};

export const deleteGlobalAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot delete another user's account data");

		const type = req.params.type as string;
		if (FORBIDDEN_TYPES.has(type))
			throw badJson(`Cannot delete ${type} via this endpoint`);

		await storage.deleteGlobalAccountData(userId, type);
		return { status: 200, body: {} };
	};

export const getRoomAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot access another user's account data");

		const roomId = req.params.roomId as RoomId;
		const type = req.params.type as string;
		const data = await storage.getRoomAccountData(userId, roomId, type);
		// MSC3391: a deleted entry is stored as an empty-object tombstone; treat it
		// as absent for GET (404).
		if (!data || isEmptyObject(data)) throw notFound("Account data not found");
		return { status: 200, body: data };
	};

export const putRoomAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot set another user's account data");

		const roomId = req.params.roomId as RoomId;
		const type = req.params.type as string;
		if (FORBIDDEN_TYPES.has(type))
			throw badJson(`Cannot set ${type} via this endpoint`);

		const content = req.body as JsonObject;
		// MSC3391: PUT with an empty content dictionary deletes the account data
		// type, so a subsequent GET returns 404.
		if (isEmptyObject(content)) {
			await storage.deleteRoomAccountData(
				userId,
				roomId,
				type,
			);
			return { status: 200, body: {} };
		}
		await storage.setRoomAccountData(userId, roomId, type, content);
		return { status: 200, body: {} };
	};

export const deleteRoomAccountData =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot delete another user's account data");

		const roomId = req.params.roomId as RoomId;
		const type = req.params.type as string;
		if (FORBIDDEN_TYPES.has(type))
			throw badJson(`Cannot delete ${type} via this endpoint`);

		await storage.deleteRoomAccountData(userId, roomId, type);
		return { status: 200, body: {} };
	};

export const getTags =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot access another user's tags");

		const roomId = req.params.roomId as RoomId;
		const data = await storage.getRoomAccountData(userId, roomId, "m.tag");
		const tags = data ? ((data as Record<string, unknown>).tags ?? {}) : {};
		return { status: 200, body: { tags } };
	};

export const putTag =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot set another user's tags");

		const roomId = req.params.roomId as RoomId;
		const tag = req.params.tag as string;

		if (Buffer.byteLength(tag, "utf-8") > 255)
			throw badJson("Tag name exceeds 255 bytes");

		const body = (req.body ?? {}) as Record<string, unknown>;

		const existing = await storage.getRoomAccountData(userId, roomId, "m.tag");
		const tags = existing
			? {
					...(((existing as Record<string, unknown>).tags as Record<
						string,
						unknown
					>) ?? {}),
				}
			: {};

		const tagData: Record<string, unknown> = {};
		if (body.order !== undefined) tagData.order = body.order;
		tags[tag] = tagData;

		await storage.setRoomAccountData(userId, roomId, "m.tag", {
			tags,
		} as JsonObject);
		return { status: 200, body: {} };
	};

export const deleteTag =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot delete another user's tags");

		const roomId = req.params.roomId as RoomId;
		const tag = req.params.tag as string;

		const existing = await storage.getRoomAccountData(userId, roomId, "m.tag");
		if (!existing) return { status: 200, body: {} };

		const tags = {
			...(((existing as Record<string, unknown>).tags as Record<
				string,
				unknown
			>) ?? {}),
		};
		delete tags[tag];

		await storage.setRoomAccountData(userId, roomId, "m.tag", {
			tags,
		} as JsonObject);
		return { status: 200, body: {} };
	};
