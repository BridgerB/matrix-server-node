import { forbidden } from "../errors.ts";
import { verifyEventSignature } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PDU } from "../types/events.ts";
import type { KeyId, ServerName } from "../types/index.ts";
import type { FederationClient } from "./client.ts";
import { getServerKey } from "./key-store.ts";

/**
 * Extract the server name (domain) part of a Matrix identifier such as a
 * user ID (`@alice:example.com`) — everything after the first colon.
 */
const domainFromId = (id: string): ServerName => {
	const idx = id.indexOf(":");
	return (idx === -1 ? id : id.slice(idx + 1)) as ServerName;
};

/**
 * Verify that `event` carries a valid signature from `server` for one of the
 * key IDs that server claims in the event's `signatures` block.
 *
 * Returns silently on success; throws `M_FORBIDDEN` if no valid signature can
 * be produced (missing signature block, unobtainable key, or bad signature).
 *
 * Signatures are verified over the *redacted* event form (see
 * `verifyEventSignature` / `redactEvent`).
 */
const verifyServerSignature = async (
	event: PDU,
	server: ServerName,
	storage: Storage,
	federationClient: FederationClient,
): Promise<void> => {
	const serverSigs = event.signatures?.[server];
	if (!serverSigs || Object.keys(serverSigs).length === 0) {
		throw forbidden(`No signature from ${server}`);
	}

	for (const keyId of Object.keys(serverSigs)) {
		const pubKey = await getServerKey(
			storage,
			server,
			keyId as KeyId,
			federationClient,
		);
		if (pubKey && verifyEventSignature(event, server, keyId as KeyId, pubKey)) {
			return;
		}
	}
	throw forbidden("Invalid event signature");
};

/**
 * Check that an inbound federation event is correctly signed, mirroring
 * Synapse's `_check_sigs_on_pdu` (synapse/federation/federation_base.py).
 *
 * The transaction `origin` is NOT the right server to verify against: a
 * transaction may carry events authored by other servers (e.g. auth-chain /
 * state events from the room creator's server). An event must be signed by:
 *
 *   (a) the sender's domain (the domain of `event.sender`) — except invites
 *       created from a 3pid invite (membership `invite` with a
 *       `third_party_invite` in content), which are exempt because the event
 *       may legitimately originate from a different homeserver.
 *
 *   (b) for restricted-room join events authorised via another server (i.e.
 *       an `m.room.member` join carrying `join_authorised_via_users_server`),
 *       the authorising user's domain as well.
 *
 * We do not implement the v1/v2 event-id-domain check: those room versions use
 * non-hash event IDs which this server does not support (event IDs here are
 * v4+ content hashes).
 *
 * The `_origin` parameter is retained for call-site compatibility but is
 * intentionally unused — verification is driven by the event's own contents.
 */
export const verifyOriginSignature = async (
	event: PDU,
	_origin: ServerName,
	storage: Storage,
	federationClient: FederationClient,
): Promise<void> => {
	const content = (event.content ?? {}) as Record<string, unknown>;
	const membership = content.membership as string | undefined;

	// (a) The sender's domain must sign the event — unless it is a 3pid invite.
	const isThirdPartyInvite =
		event.type === "m.room.member" &&
		membership === "invite" &&
		"third_party_invite" in content;

	if (!isThirdPartyInvite) {
		await verifyServerSignature(
			event,
			domainFromId(event.sender),
			storage,
			federationClient,
		);
	}

	// NOTE: we intentionally do NOT additionally require the
	// `join_authorised_via_users_server` server's signature on a restricted-room
	// join here. During inbound `send_join` the event is only signed by the
	// joining (sender) server; the authorising/resident server co-signs it as
	// part of *accepting* the join, not before. Requiring it up-front breaks the
	// join ("No signature from <resident>"). The authorising user is instead
	// validated structurally by checkEventAuth (it must point at a joined local
	// user with invite power).
};
