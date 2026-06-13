import { forbidden, serverNotTrusted } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import { getServerKey } from "../federation/key-store.ts";
import type { Middleware } from "../router.ts";
import { verifyJsonSignature } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { KeyId, ServerName } from "../types/index.ts";

const parseXMatrixAuth = (
	header: string,
): { origin: string; destination: string; key: string; sig: string } | null => {
	const content = header.slice(9);
	const result = Object.fromEntries(
		[...content.matchAll(/(\w+)="([^"]*?)"/g)].map(
			(m) => [m[1], m[2]] as [string, string],
		),
	);

	if (!result.origin || !result.destination || !result.key || !result.sig)
		return null;

	return {
		origin: result.origin,
		destination: result.destination,
		key: result.key,
		sig: result.sig,
	};
};

export const requireFederationAuth =
	(
		serverName: string,
		storage: Storage,
		federationClient: FederationClient,
	): Middleware =>
	async (req, next) => {
		const authHeader = req.headers.authorization;
		if (!authHeader?.startsWith("X-Matrix "))
			throw forbidden("Missing X-Matrix authorization");

		const params = parseXMatrixAuth(authHeader);
		if (!params) throw forbidden("Invalid X-Matrix authorization header");

		if (params.destination !== serverName)
			throw forbidden(
				`Destination mismatch: expected ${serverName}, got ${params.destination}`,
			);

		const pubKey = await getServerKey(
			storage,
			params.origin as ServerName,
			params.key as KeyId,
			federationClient,
		);
		if (!pubKey)
			throw serverNotTrusted(
				`Could not fetch key ${params.key} from ${params.origin}`,
			);

		const hasContent =
			typeof req.body === "object" &&
			req.body !== null &&
			Object.keys(req.body).length > 0;

		const signedObj: Record<string, unknown> = {
			method: req.method,
			// The signed URI is the request target EXACTLY as the origin sent it.
			// Re-serialising via URLSearchParams.toString() re-encodes query
			// strings differently (e.g. `@`/`:` in a user_id, or `+` vs %20) and
			// breaks signature verification for any federation GET with a query
			// string (query/profile, query/directory, …). Use the raw URL.
			uri: req.raw.url ?? req.path,
			origin: params.origin,
			destination: params.destination,
			...(hasContent ? { content: req.body } : {}),
			signatures: { [params.origin]: { [params.key]: params.sig } },
		};

		const valid = verifyJsonSignature(
			signedObj,
			params.origin as ServerName,
			params.key as KeyId,
			pubKey,
		);
		if (!valid) throw forbidden("Invalid federation signature");

		req.origin = params.origin as ServerName;
		return next(req);
	};
