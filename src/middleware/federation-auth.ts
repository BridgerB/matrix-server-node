import { forbidden, serverNotTrusted } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import type { RemoteKeyStore } from "../federation/key-store.ts";
import type { Middleware } from "../router.ts";
import { verifyJsonSignature } from "../signing.ts";
import type { KeyId, ServerName } from "../types/index.ts";

// =============================================================================
// X-Matrix Authorization Middleware
// =============================================================================

export function requireFederationAuth(
	serverName: string,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Middleware {
	return async (req, next) => {
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith("X-Matrix ")) {
			throw forbidden("Missing X-Matrix authorization");
		}

		const params = parseXMatrixAuth(authHeader);
		if (!params) throw forbidden("Invalid X-Matrix authorization header");

		// Verify destination matches us
		if (params.destination !== serverName) {
			throw forbidden(
				`Destination mismatch: expected ${serverName}, got ${params.destination}`,
			);
		}

		// Fetch the origin server's public key
		const pubKey = await remoteKeyStore.getServerKey(
			params.origin as ServerName,
			params.key as KeyId,
			federationClient,
		);
		if (!pubKey) {
			throw serverNotTrusted(
				`Could not fetch key ${params.key} from ${params.origin}`,
			);
		}

		// Reconstruct the signed object
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

		// Add the signature for verification
		signedObj.signatures = {
			[params.origin]: { [params.key]: params.sig },
		};

		const valid = verifyJsonSignature(
			signedObj,
			params.origin as ServerName,
			params.key as KeyId,
			pubKey,
		);
		if (!valid) {
			throw forbidden("Invalid federation signature");
		}

		// Attach origin to request
		req.origin = params.origin as ServerName;

		return next(req);
	};
}

function parseXMatrixAuth(
	header: string,
): { origin: string; destination: string; key: string; sig: string } | null {
	const content = header.slice(9); // Remove "X-Matrix "
	const result: Record<string, string> = {};

	// Parse key="value" pairs
	const regex = /(\w+)="([^"]*?)"/g;
	let match: RegExpExecArray | null = regex.exec(content);
	while (match !== null) {
		result[match[1] as string] = match[2] as string;
		match = regex.exec(content);
	}

	if (!result.origin || !result.destination || !result.key || !result.sig) {
		return null;
	}

	return {
		origin: result.origin as string,
		destination: result.destination as string,
		key: result.key as string,
		sig: result.sig as string,
	};
}
