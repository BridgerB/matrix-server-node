import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import { signJson } from "../../signing.ts";
import type { ServerKeys } from "../../types/federation.ts";
import type { KeyId, ServerName } from "../../types/index.ts";

export const getServerKeys =
	(serverName: string, signingKey: SigningKey): Handler =>
	(_req) => {
		const response: ServerKeys = {
			server_name: serverName as ServerName,
			verify_keys: {
				[signingKey.keyId]: { key: signingKey.publicKeyBase64 },
			} as Record<KeyId, { key: string }>,
			old_verify_keys: {},
			valid_until_ts: Date.now() + 24 * 60 * 60 * 1000,
			signatures: {} as Record<ServerName, Record<KeyId, string>>,
		};

		signJson(
			response as unknown as Record<string, unknown>,
			serverName as ServerName,
			signingKey,
		);

		return { status: 200, body: response };
	};
