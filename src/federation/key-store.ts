import type { Storage } from "../storage/interface.ts";
import type { ServerName, KeyId } from "../types/index.ts";
import type { ServerKeys } from "../types/federation.ts";
import type { FederationClient } from "./client.ts";
import { verifyJsonSignature } from "../signing.ts";

export class RemoteKeyStore {
	storage: Storage;

	constructor(storage: Storage) {
		this.storage = storage;
	}

	async getServerKey(
		serverName: ServerName,
		keyId: KeyId,
		client: FederationClient,
	): Promise<string | undefined> {
		// Check cache first
		const cached = await this.storage.getServerKeys(serverName, keyId);
		if (cached && cached.validUntil > Date.now()) {
			return cached.key;
		}

		// Fetch from remote server
		try {
			const resp = await client.request(
				serverName,
				"GET",
				"/_matrix/key/v2/server",
			);

			if (resp.status !== 200) return undefined;

			const keys = resp.body as ServerKeys;
			if (!keys?.server_name || keys.server_name !== serverName)
				return undefined;

			// Verify self-signature
			const firstKeyId = Object.keys(keys.verify_keys)[0];
			if (!firstKeyId) return undefined;
			const firstKey = keys.verify_keys[firstKeyId as KeyId]!.key;

			const valid = verifyJsonSignature(
				keys as unknown as Record<string, unknown>,
				serverName,
				firstKeyId as KeyId,
				firstKey,
			);
			if (!valid) return undefined;

			// Cache the keys
			await this.storage.storeServerKeys(serverName, keys);

			// Return the requested key
			const requested = keys.verify_keys[keyId];
			return requested?.key;
		} catch {
			return undefined;
		}
	}
}
