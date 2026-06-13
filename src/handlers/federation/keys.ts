import type { Handler } from "../../router.ts";
import type { SigningKey } from "../../signing.ts";
import { signJson } from "../../signing.ts";
import type { ServerName } from "../../types/index.ts";

export const getServerKeys =
	(serverName: string, signingKey: SigningKey): Handler =>
	(_req) => {
		// The Complement test (TestInboundFederationKeys) verifies the ed25519
		// signature by deleting the top-level `signatures` field from the *raw*
		// response body (via sjson.DeleteBytes) and verifying directly over those
		// bytes — it does NOT re-canonicalize. signJson signs over canonicalJson()
		// (sorted keys, compact). For the bytes the client verifies to match the
		// bytes that were signed, JSON.stringify() of this object (which the router
		// emits verbatim) must equal canonicalJson() of the same object.
		//
		// canonicalJson and JSON.stringify produce identical output as long as the
		// object's own keys are already in lexicographic order at every level, so
		// we insert keys in sorted order here. After sjson removes `signatures`
		// (which is not the last top-level key), the remaining bytes stay sorted
		// and therefore byte-identical to canonicalJson(response-without-sigs).
		//
		// Sorted top-level key order: old_verify_keys, server_name, signatures,
		// valid_until_ts, verify_keys.
		const response: Record<string, unknown> = {
			old_verify_keys: {},
			server_name: serverName as ServerName,
			// placeholder so `signatures` keeps its sorted position once populated
			signatures: {},
			// ~7 days in the future so clients with strict freshness checks accept it
			valid_until_ts: Date.now() + 7 * 24 * 60 * 60 * 1000,
			verify_keys: {
				[signingKey.keyId]: { key: signingKey.publicKeyBase64 },
			},
		};

		// signJson signs over canonicalJson(response minus signatures/unsigned) and
		// writes the signature into response.signatures[serverName][keyId].
		signJson(response, serverName as ServerName, signingKey);

		return { status: 200, body: response };
	};
