import { badJson, forbidden, notFound } from "../errors.ts";
import {
	buildEvent,
	checkEventAuth,
	getPowerLevels,
	getUserPowerLevel,
	pduToClientEvent,
	redactEvent,
	requireJoinedRoom,
	selectAuthEvents,
} from "../events.ts";
import { bundleAggregations, indexRelation } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { JsonObject } from "../types/json.ts";

export const putSendEvent =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const txnId = req.params.txnId as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		const existing = await storage.getTxnEventId(userId, deviceId, txnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		const room = await requireJoinedRoom(storage, roomId, userId);

		const authEvents = selectAuthEvents(eventType, undefined, room, userId);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: (req.body ?? {}) as JsonObject,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.storeEvent(event, eventId);
		await indexRelation(storage, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		await storage.setTxnEventId(userId, deviceId, txnId, eventId);
		return { status: 200, body: { event_id: eventId } };
	};

export const putStateEvent =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const stateKey = req.params.stateKey ?? "";
		const userId = req.userId as string;

		const room = await requireJoinedRoom(storage, roomId, userId);

		const authEvents = selectAuthEvents(eventType, stateKey, room, userId);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: (req.body ?? {}) as JsonObject,
			stateKey,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.setStateEvent(roomId, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		return { status: 200, body: { event_id: eventId } };
	};

export const getAllState =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const stateEntries = await storage.getAllState(roomId);
		const events = stateEntries.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		return { status: 200, body: events };
	};

export const getStateEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventType = req.params.eventType as string;
		const stateKey = req.params.stateKey ?? "";

		await requireJoinedRoom(storage, roomId, req.userId as string);

		const entry = await storage.getStateEvent(roomId, eventType, stateKey);
		if (!entry) throw notFound("State event not found");

		return { status: 200, body: entry.event.content };
	};

export const getMessages =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const dir = (req.query.get("dir") ?? "f") as "b" | "f";
		if (dir !== "b" && dir !== "f") throw badJson("dir must be 'b' or 'f'");

		const fromStr = req.query.get("from");
		const from = fromStr ? parseInt(fromStr, 10) : undefined;
		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10), 1), 100);

		const result = await storage.getEventsByRoom(roomId, limit, from, dir);
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		await bundleAggregations(storage, chunk, req.userId as string);

		return {
			status: 200,
			body: {
				start: fromStr ?? "0",
				end: result.end !== undefined ? String(result.end) : undefined,
				chunk,
			},
		};
	};

export const getMembers =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const membershipFilter = req.query.get("membership");
		const notMembershipFilter = req.query.get("not_membership");

		let entries = await storage.getMemberEvents(roomId);

		if (membershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>).membership;
				return m === membershipFilter;
			});
		}
		if (notMembershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>).membership;
				return m !== notMembershipFilter;
			});
		}

		const chunk = entries.map((e) => pduToClientEvent(e.event, e.eventId));
		return { status: 200, body: { chunk } };
	};

export const getEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;

		await requireJoinedRoom(storage, roomId, req.userId as string);

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const clientEvent = pduToClientEvent(entry.event, entry.eventId);
		await bundleAggregations(storage, [clientEvent], req.userId as string);
		return { status: 200, body: clientEvent };
	};

export const postRedact =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const targetEventId = req.params.eventId as string;
		const txnId = req.params.txnId as string;
		const userId = req.userId as string;
		const deviceId = req.deviceId as string;

		const existing = await storage.getTxnEventId(userId, deviceId, txnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		const room = await requireJoinedRoom(storage, roomId, userId);

		const targetEntry = await storage.getEvent(targetEventId);
		if (!targetEntry || targetEntry.event.room_id !== roomId)
			throw notFound("Event not found");

		const pl = getPowerLevels(room);
		const senderPl = getUserPowerLevel(userId, room);
		const redactPl = pl.redact ?? 50;
		if (senderPl < redactPl && targetEntry.event.sender !== userId) {
			throw forbidden("Insufficient power level to redact");
		}

		const body = (req.body ?? {}) as { reason?: string };
		const content: JsonObject = {};
		if (body.reason) content.reason = body.reason;

		const authEvents = selectAuthEvents(
			"m.room.redaction",
			undefined,
			room,
			userId,
		);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: "m.room.redaction",
			content,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			redacts: targetEventId,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.storeEvent(event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		const redacted = redactEvent(targetEntry.event);
		redacted.unsigned = {
			...redacted.unsigned,
			redacted_because: pduToClientEvent(event, eventId),
		};
		Object.assign(targetEntry.event, redacted);

		await storage.setTxnEventId(userId, deviceId, txnId, eventId);
		return { status: 200, body: { event_id: eventId } };
	};

export const getContext =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;
		const userId = req.userId as string;

		await requireJoinedRoom(storage, roomId, userId);

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const limit = Math.min(
			Math.max(parseInt(req.query.get("limit") ?? "10", 10), 1),
			100,
		);
		const halfLimit = Math.max(Math.floor(limit / 2), 1);

		const timeline = await storage.getEventsByRoom(
			roomId,
			10000,
			undefined,
			"f",
		);
		const targetIdx = timeline.events.findIndex((e) => e.eventId === eventId);

		let eventsBefore: typeof timeline.events = [];
		let eventsAfter: typeof timeline.events = [];

		if (targetIdx >= 0) {
			eventsBefore = timeline.events
				.slice(Math.max(0, targetIdx - halfLimit), targetIdx)
				.reverse();
			eventsAfter = timeline.events.slice(
				targetIdx + 1,
				targetIdx + 1 + halfLimit,
			);
		}

		const stateEntries = await storage.getAllState(roomId);
		const state = stateEntries.map((e) => pduToClientEvent(e.event, e.eventId));

		const contextEvent = pduToClientEvent(entry.event, entry.eventId);
		const beforeEvents = eventsBefore.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		const afterEvents = eventsAfter.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		await bundleAggregations(
			storage,
			[contextEvent, ...beforeEvents, ...afterEvents],
			userId,
		);

		return {
			status: 200,
			body: {
				event: contextEvent,
				events_before: beforeEvents,
				events_after: afterEvents,
				state,
				start:
					eventsBefore.length > 0
						? String(targetIdx - eventsBefore.length)
						: undefined,
				end:
					eventsAfter.length > 0
						? String(targetIdx + eventsAfter.length + 1)
						: undefined,
			},
		};
	};
