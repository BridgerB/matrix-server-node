import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { ServerKeys } from "../../types/federation.ts";
import type { KeyId, ServerName } from "../../types/index.ts";

export const postKeyQuery =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			server_keys?: Record<string, Record<string, { minimum_valid_until_ts?: number }>>;
		};

		const serverKeys: ServerKeys[] = [];

		if (body.server_keys) {
			for (const [serverName, keyRequests] of Object.entries(body.server_keys)) {
				for (const keyId of Object.keys(keyRequests)) {
					const cached = await storage.getServerKeys(
						serverName as ServerName,
						keyId as KeyId,
					);
					if (cached) {
						const entry: ServerKeys = {
							server_name: serverName as ServerName,
							verify_keys: {
								[keyId]: { key: cached.key },
							} as Record<KeyId, { key: string }>,
							old_verify_keys: {},
							valid_until_ts: cached.validUntil,
							signatures: {} as Record<ServerName, Record<KeyId, string>>,
						};
						serverKeys.push(entry);
					}
				}
			}
		}

		return { status: 200, body: { server_keys: serverKeys } };
	};

export const getKeyQuery =
	(_storage: Storage): Handler =>
	async (_req) => {
		// const serverName = req.params.serverName as ServerName;
		const serverKeys: ServerKeys[] = [];

		// We don't have a way to enumerate all keys for a server,
		// so we try the common key ID prefix "ed25519:" and look up what we have cached.
		// The spec says this endpoint returns whatever we have cached for this server.
		// Since we store keys individually by serverName+keyId, we check for the server
		// in our cache. Without a listing method, we return what we can find.
		// For a more complete implementation, storage would need a listServerKeys method.

		// Return empty array - we don't have a way to enumerate keys for a server
		// without knowing the specific keyId
		return { status: 200, body: { server_keys: serverKeys } };
	};
