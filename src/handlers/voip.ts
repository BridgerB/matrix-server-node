import type { Handler } from "../router.ts";

export const getTurnServer = (): Handler => async (_req) => ({
	status: 200,
	body: {
		username: "",
		password: "",
		uris: [],
		ttl: 86400,
	},
});
