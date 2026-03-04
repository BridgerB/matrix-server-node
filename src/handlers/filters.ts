import { forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const postCreateFilter =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot create filters for another user");

		const filter = req.body as JsonObject;
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
