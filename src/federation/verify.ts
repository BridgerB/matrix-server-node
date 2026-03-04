import { forbidden } from "../errors.ts";
import { verifyEventSignature } from "../signing.ts";
import type { PDU } from "../types/events.ts";
import type { KeyId, ServerName } from "../types/index.ts";
import type { FederationClient } from "./client.ts";
import type { RemoteKeyStore } from "./key-store.ts";

export const verifyOriginSignature = async (
	event: PDU,
	origin: ServerName,
	remoteKeyStore: RemoteKeyStore,
	federationClient: FederationClient,
): Promise<void> => {
	const originSigs = event.signatures?.[origin];
	if (!originSigs) throw forbidden(`No signature from origin ${origin}`);

	for (const keyId of Object.keys(originSigs)) {
		const pubKey = await remoteKeyStore.getServerKey(
			origin,
			keyId as KeyId,
			federationClient,
		);
		if (pubKey && verifyEventSignature(event, origin, keyId as KeyId, pubKey))
			return;
	}
	throw forbidden("Invalid event signature");
};
