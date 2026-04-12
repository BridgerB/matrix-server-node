import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pduToClientEvent } from "../events.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";
import type { PDU } from "../types/events.ts";
import type { EventId } from "../types/identifiers.ts";

let txnCounter = 0;

// Cache compiled regexes per registration to avoid recompilation on every event
const regexCache = new WeakMap<
	{ regex: string },
	RegExp
>();

const getRegex = (ns: { regex: string }): RegExp => {
	let cached = regexCache.get(ns);
	if (!cached) {
		cached = new RegExp(ns.regex);
		regexCache.set(ns, cached);
	}
	return cached;
};

/**
 * Push an event to all appservices whose namespaces match the event.
 *
 * Matching criteria (any match triggers a push):
 * - The event sender matches a user namespace
 * - A state_key (for membership events) matches a user namespace
 * - The room_id matches a room namespace
 *
 * Requests are fire-and-forget: failures are logged but not propagated.
 */
export const pushToAppservices = (
	event: PDU,
	eventId: EventId,
	registrations: AppserviceRegistration[],
): void => {
	const clientEvent = pduToClientEvent(event, eventId);

	for (const reg of registrations) {
		if (!reg.url) continue;

		const matchesUser = reg.namespaces.users?.some(
			(ns) =>
				getRegex(ns).test(event.sender) ||
				(event.state_key !== undefined &&
					getRegex(ns).test(event.state_key)),
		);

		const matchesRoom = reg.namespaces.rooms?.some((ns) =>
			getRegex(ns).test(event.room_id),
		);

		if (!matchesUser && !matchesRoom) continue;

		const txnId = `${Date.now()}_${++txnCounter}`;
		const body = JSON.stringify({ events: [clientEvent] });

		try {
			const url = new URL(
				`/_matrix/app/v1/transactions/${txnId}`,
				reg.url,
			);

			const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;

			const outReq = reqFn(
				url,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body).toString(),
						Authorization: `Bearer ${reg.hs_token}`,
					},
					timeout: 30_000,
				},
				(res) => {
					// Drain the response
					res.resume();
					if (res.statusCode && res.statusCode >= 400) {
						console.error(
							`Appservice ${reg.id} returned ${res.statusCode} for txn ${txnId}`,
						);
					}
				},
			);

			outReq.on("error", (err) => {
				console.error(`Failed to push to appservice ${reg.id}:`, err.message);
			});

			outReq.end(body);
		} catch (err) {
			console.error(
				`Failed to push to appservice ${reg.id}:`,
				(err as Error).message,
			);
		}
	}
};
