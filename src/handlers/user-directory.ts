import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export const postUserDirectorySearch =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as { search_term?: string; limit?: number };
		if (!body.search_term) throw badJson("Missing search_term");

		const limit = Math.min(Math.max(body.limit ?? 10, 1), 50);
		const results = await storage.searchUserDirectory(
			body.search_term,
			limit + 1,
		);

		const limited = results.length > limit;
		const sliced = results.slice(0, limit);

		return {
			status: 200,
			body: { results: sliced, limited },
		};
	};
