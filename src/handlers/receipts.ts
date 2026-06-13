import { generateToken } from "../crypto.ts";
import { membershipOf } from "../events.ts";
import { domainOf } from "../ids.ts";
import type { FederationClient } from "../federation/client.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId, ServerName, UserId } from "../types/index.ts";

/**
 * Notify remote servers sharing the room that a local user posted a read
 * receipt, by sending an `m.receipt` EDU in a federation transaction to each
 * distinct remote destination joined to the room. Fire-and-forget: errors per
 * destination are swallowed so they never affect the client's response.
 *
 * The EDU content shape matches what our inbound transaction handler reads
 * (`src/handlers/federation/transactions.ts`, `m.receipt` case):
 *
 *   { room_id, receipts: { <eventId>: { <receiptType>: { <userId>: { ts } } } } }
 *
 * Note: only `m.read` (and `m.read.private` would be local-only) receipts are
 * federated. `m.read.private` MUST NOT be sent to other servers per the spec,
 * so it is excluded here.
 */
export const sendReceiptEdu = async (
	storage: Storage,
	serverName: ServerName,
	federationClient: FederationClient,
	roomId: RoomId,
	userId: UserId,
	eventId: EventId,
	receiptType: string,
	ts: number,
	threadId: string | undefined,
): Promise<void> => {
	const members = await storage.getMemberEvents(roomId);
	const destinations = new Set<ServerName>();
	for (const { event } of members) {
		const membership = membershipOf(event);
		if (membership !== "join") continue;
		const memberId = event.state_key;
		if (!memberId) continue;
		const memberServer = domainOf(memberId);
		if (memberServer && memberServer !== serverName) {
			destinations.add(memberServer as ServerName);
		}
	}

	if (destinations.size === 0) return;

	const data: { ts: number; thread_id?: string } = { ts };
	if (threadId !== undefined) data.thread_id = threadId;

	// Federation m.receipt EDU (server-server-api): content is keyed
	// room_id -> receipt_type -> user_id -> { data: { ts }, event_ids: [...] }.
	const edu = {
		edu_type: "m.receipt",
		content: {
			[roomId]: {
				[receiptType]: {
					[userId]: { data, event_ids: [eventId] },
				},
			},
		},
	};

	for (const dest of destinations) {
		const txnId = generateToken();
		const txn = {
			origin: serverName,
			origin_server_ts: Date.now(),
			pdus: [],
			edus: [edu],
		};
		void federationClient
			.request(dest, "PUT", `/_matrix/federation/v1/send/${txnId}`, txn)
			.catch(() => {});
	}
};

export const postReceipt =
	(
		storage: Storage,
		serverName?: ServerName,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const receiptType = req.params.receiptType as string;
		const eventId = req.params.eventId as EventId;
		const userId = req.userId as UserId;
		const threadId = (req.body as { thread_id?: string } | undefined)
			?.thread_id;
		const ts = Date.now();

		await storage.setReceipt(
			roomId,
			userId,
			eventId,
			receiptType,
			ts,
			threadId,
		);

		// Federate the receipt to remote servers in the room. Private receipts
		// (`m.read.private`) MUST NOT be federated.
		if (serverName && federationClient && receiptType !== "m.read.private") {
			void sendReceiptEdu(
				storage,
				serverName,
				federationClient,
				roomId,
				userId,
				eventId,
				receiptType,
				ts,
				threadId,
			).catch(() => {});
		}

		return { status: 200, body: {} };
	};
