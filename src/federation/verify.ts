import { forbidden } from "../errors.ts";
import { verifyEventSignature } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type { KeyId, ServerName } from "../types/index.ts";
import type { FederationClient } from "./client.ts";
import { getServerKey } from "./key-store.ts";

export const verifyOriginSignature = async (
	event: PDU,
	origin: ServerName,
	storage: Storage,
	federationClient: FederationClient,
): Promise<void> => {
	const originSigs = event.signatures?.[origin];
	if (!originSigs) throw forbidden(`No signature from origin ${origin}`);

	for (const keyId of Object.keys(originSigs)) {
		const pubKey = await getServerKey(
			storage,
			origin,
			keyId as KeyId,
			federationClient,
		);
		if (pubKey && verifyEventSignature(event, origin, keyId as KeyId, pubKey))
			return;
	}
	throw forbidden("Invalid event signature");
};
