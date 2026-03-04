import type { Handler } from "../router.ts";

// =============================================================================
// GET /_matrix/client/v3/voip/turnServer
// =============================================================================

export function getTurnServer(): Handler {
	return async (_req) => {
		return {
			status: 200,
			body: {
				username: "",
				password: "",
				uris: [],
				ttl: 86400,
			},
		};
	};
}
