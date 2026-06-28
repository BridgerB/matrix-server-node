import { KEY_SEP } from "./events.ts";
import { domainOf } from "./ids.ts";
import { evaluatePushRules, getOrInitRules } from "./push-rules.ts";
import type { Storage } from "./storage/interface.ts";
import type { PDU } from "./types/events.ts";
import type { EventId, RoomId, UserId } from "./types/identifiers.ts";
import type { RoomState } from "./types/internal.ts";
import type { JsonObject, JsonValue } from "./types/json.ts";
import type { Pusher, PushNotification } from "./types/push.ts";
import type { RoomPowerLevelsContent } from "./types/state-events.ts";

const MEMBER_PREFIX = `m.room.member${KEY_SEP}`;
const POWER_LEVELS_KEY = `m.room.power_levels${KEY_SEP}`;
const ROOM_NAME_KEY = `m.room.name${KEY_SEP}`;
const NOTIFY_TIMEOUT_MS = 10_000;

const contentOf = (pdu: PDU | undefined): Record<string, unknown> =>
	(pdu?.content as Record<string, unknown> | undefined) ?? {};

/**
 * Server-side push dispatch (the Matrix push-gateway notify loop).
 *
 * Given a freshly-stored event, evaluate each LOCAL joined member's push rules
 * and, for those whose rules say `notify`, POST the standard push-gateway
 * `notification` payload to every `kind:"http"` pusher they have registered
 * (Client-Server `pushers/set` -> `data.url`, Push-Gateway `POST .../notify`).
 * Pushkeys the gateway reports in `rejected` are pruned from storage.
 *
 * Best-effort and self-contained: it swallows its own errors and is intended to
 * be called fire-and-forget from the send path (not awaited), alongside the
 * federation/appservice fan-out. Badge `counts.unread` is a v1 placeholder (see
 * below) — the trigger + payload are the point here, exact badge counts can be
 * refined later without touching callers.
 */
export const dispatchPushNotifications = async (
	storage: Storage,
	serverName: string,
	event: PDU,
	eventId: EventId,
	room: RoomState,
): Promise<void> => {
	// Room-level context shared by every recipient (cheap, computed once).
	const powerLevels = room.state_events.get(POWER_LEVELS_KEY)?.content as
		| RoomPowerLevelsContent
		| undefined;
	const senderPowerLevel =
		powerLevels?.users?.[event.sender as UserId] ??
		powerLevels?.users_default ??
		0;
	const roomNameRaw = contentOf(room.state_events.get(ROOM_NAME_KEY)).name;
	const roomName = typeof roomNameRaw === "string" ? roomNameRaw : undefined;
	const senderDisplayRaw = contentOf(
		room.state_events.get(`${MEMBER_PREFIX}${event.sender}`),
	).displayname;
	const senderDisplayName =
		typeof senderDisplayRaw === "string" ? senderDisplayRaw : undefined;

	// Single pass over current state: collect local joined recipients (excluding
	// the sender) and the total joined member count (local + remote) for the
	// `room_member_count` push condition.
	const recipients: { userId: UserId; displayName?: string }[] = [];
	let memberCount = 0;
	for (const [key, pdu] of room.state_events) {
		if (!key.startsWith(MEMBER_PREFIX)) continue;
		if (contentOf(pdu).membership !== "join") continue;
		memberCount++;
		const userId = key.slice(MEMBER_PREFIX.length) as UserId;
		if (userId === (event.sender as UserId)) continue;
		if (domainOf(userId) !== serverName) continue;
		const dn = contentOf(pdu).displayname;
		recipients.push({
			userId,
			displayName: typeof dn === "string" ? dn : undefined,
		});
	}
	if (recipients.length === 0) return;

	const isEncrypted = event.type === "m.room.encrypted";

	for (const recipient of recipients) {
		// Cost guard: skip the push-rule evaluation entirely for users with no
		// HTTP pushers registered.
		let pushers: Pusher[];
		try {
			pushers = await storage.getPushers(recipient.userId);
		} catch {
			continue;
		}
		const httpPushers = pushers.filter(
			(p) => p.kind === "http" && typeof p.data?.url === "string",
		);
		if (httpPushers.length === 0) continue;

		const rules = await getOrInitRules(storage, recipient.userId);
		const result = evaluatePushRules(rules, {
			event,
			userId: recipient.userId,
			displayName: recipient.displayName,
			memberCount,
			powerLevels,
			senderPowerLevel,
		});
		if (!result.notify) continue;

		const tweaks: Record<string, JsonValue> = { highlight: result.highlight };
		if (result.sound !== undefined) tweaks.sound = result.sound;

		// One POST per pusher (devices array of length 1). hoot's gateway is
		// stateless and per-pushkey, so this keeps each request self-describing.
		for (const pusher of httpPushers) {
			const url = pusher.data.url as string;
			const eventIdOnly = pusher.data.format === "event_id_only";

			const notification: PushNotification["notification"] = {
				event_id: eventId,
				room_id: event.room_id as RoomId,
				prio: "high",
				counts: { unread: 1 },
				devices: [
					{
						app_id: pusher.app_id,
						pushkey: pusher.pushkey,
						data: pusher.data as unknown as JsonObject,
						tweaks,
					},
				],
			};

			if (!eventIdOnly) {
				notification.type = event.type;
				notification.sender = event.sender as UserId;
				if (senderDisplayName)
					notification.sender_display_name = senderDisplayName;
				if (roomName) notification.room_name = roomName;
				// Never leak ciphertext-protected content for E2EE events; the client
				// fetches/decrypts on its own when it sees the event id.
				if (!isEncrypted) notification.content = event.content as JsonObject;
			}

			let rejected: string[] = [];
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ notification }),
					signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
				});
				if (res.ok) {
					const body = (await res.json()) as { rejected?: unknown };
					if (Array.isArray(body.rejected)) {
						rejected = body.rejected.filter(
							(k): k is string => typeof k === "string",
						);
					}
				}
			} catch {
				// Gateway unreachable / timed out / bad JSON: best-effort, drop it.
				continue;
			}

			// Prune pushkeys the gateway rejected (e.g. expired web-push sub).
			for (const pushkey of rejected) {
				try {
					await storage.deletePusherByKey(pusher.app_id, pushkey);
				} catch {
					// ignore prune failures
				}
			}
		}
	}
};
