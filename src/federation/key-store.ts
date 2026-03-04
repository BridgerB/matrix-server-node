import { verifyJsonSignature } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerKeys } from "../types/federation.ts";
import type { KeyId, ServerName } from "../types/index.ts";
import type { FederationClient } from "./client.ts";

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
		const cached = await this.storage.getServerKeys(serverName, keyId);
		if (cached && cached.validUntil > Date.now()) return cached.key;

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

			const firstKeyId = Object.keys(keys.verify_keys)[0];
			if (!firstKeyId) return undefined;
			const firstKey = keys.verify_keys[firstKeyId as KeyId]?.key;
			if (!firstKey) return undefined;

			const valid = verifyJsonSignature(
				keys as unknown as Record<string, unknown>,
				serverName,
				firstKeyId as KeyId,
				firstKey,
			);
			if (!valid) return undefined;

			await this.storage.storeServerKeys(serverName, keys);
			return keys.verify_keys[keyId]?.key;
		} catch {
			return undefined;
		}
	}
}
