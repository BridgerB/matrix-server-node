import { forbidden, serverNotTrusted } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import type { RemoteKeyStore } from "../federation/key-store.ts";
import type { Middleware } from "../router.ts";
import { verifyJsonSignature } from "../signing.ts";
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
		remoteKeyStore: RemoteKeyStore,
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

		const pubKey = await remoteKeyStore.getServerKey(
			params.origin as ServerName,
			params.key as KeyId,
			federationClient,
		);
		if (!pubKey)
			throw serverNotTrusted(
				`Could not fetch key ${params.key} from ${params.origin}`,
			);

		const signedObj: Record<string, unknown> = {
			method: req.method,
			uri: req.path + (req.query.toString() ? `?${req.query.toString()}` : ""),
			origin: params.origin,
			destination: params.destination,
		};
		if (
			req.body !== undefined &&
			req.body !== null &&
			typeof req.body === "object" &&
			Object.keys(req.body as object).length > 0
		) {
			signedObj.content = req.body;
		}

		signedObj.signatures = {
			[params.origin]: { [params.key]: params.sig },
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
