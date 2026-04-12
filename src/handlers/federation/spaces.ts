import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";

/**
 * GET /_matrix/federation/v1/hierarchy/:roomId
 *
 * Federation endpoint for space hierarchy. Returns the room hierarchy
 * visible from the requesting server's perspective.
 */
export const postFederationHierarchy =
	(_storage: Storage): Handler =>
	async (_req) => {
		// Stub: return empty hierarchy
		return {
			status: 200,
			body: {
				room: {},
				children: [],
				inaccessible_children: [],
			},
		};
	};
