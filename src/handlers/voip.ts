import { createHmac } from "node:crypto";
import type { Handler } from "../router.ts";

export const getTurnServer = (): Handler => async (req) => {
	const turnUrisEnv = process.env.TURN_URIS;
	const sharedSecret = process.env.TURN_SHARED_SECRET;
	const staticUsername = process.env.TURN_USERNAME;
	const staticPassword = process.env.TURN_PASSWORD;
	const ttl = parseInt(process.env.TURN_TTL ?? "86400", 10);

	// No TURN configured — return empty credentials
	if (!turnUrisEnv) {
		return {
			status: 200,
			body: {
				username: "",
				password: "",
				uris: [],
				ttl: 86400,
			},
		};
	}

	const uris = turnUrisEnv.split(",").map((u) => u.trim());

	if (sharedSecret) {
		// Generate time-limited HMAC credentials (coturn use_auth_secret mode)
		const expiry = Math.floor(Date.now() / 1000) + ttl;
		const userId = req.userId ?? "anonymous";
		const username = `${expiry}:${userId}`;
		const password = createHmac("sha1", sharedSecret)
			.update(username)
			.digest("base64");

		return {
			status: 200,
			body: {
				username,
				password,
				uris,
				ttl,
			},
		};
	}

	if (staticUsername && staticPassword) {
		return {
			status: 200,
			body: {
				username: staticUsername,
				password: staticPassword,
				uris,
				ttl,
			},
		};
	}

	// TURN_URIS set but no credentials configured
	return {
		status: 200,
		body: {
			username: "",
			password: "",
			uris,
			ttl,
		},
	};
};
