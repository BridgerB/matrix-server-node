// =============================================================================
// EVENTS - BASE TYPES
// =============================================================================

import type {
	EventId,
	RoomId,
	UserId,
	ServerName,
	KeyId,
	Base64,
	Timestamp,
	TransactionId,
} from "./identifiers.ts";
import type { JsonObject, JsonValue } from "./json.ts";

/** Unsigned data attached to events (not part of the hash/signature) */
export interface UnsignedData {
	age?: number;
	transaction_id?: TransactionId;
	prev_content?: JsonObject;
	redacted_because?: ClientEvent;
	"m.relations"?: Record<string, JsonValue>;
}

/**
 * Persistent Data Unit - the fundamental event structure used in federation.
 * This is the canonical form of an event as stored and transmitted between servers.
 */
export interface PDU {
	auth_events: EventId[];
	content: JsonObject;
	depth: number;
	hashes: { sha256: Base64 };
	origin_server_ts: Timestamp;
	prev_events: EventId[];
	room_id: RoomId;
	sender: UserId;
	signatures: Record<ServerName, Record<KeyId, Base64>>;
	state_key?: string;
	type: string;
	unsigned?: UnsignedData;
	redacts?: EventId;

	// v1/v2 format
	event_id?: EventId;
	// v3+ format: event_id derived from content hash
}

/**
 * Ephemeral Data Unit - non-persistent events for federation.
 * Typing, presence, receipts, device list updates, etc.
 */
export interface EDU {
	edu_type: string;
	content: JsonObject;
}

/** Event as returned to clients via the Client-Server API */
export interface ClientEvent {
	content: JsonObject;
	event_id: EventId;
	origin_server_ts: Timestamp;
	room_id?: RoomId; // omitted in some sync contexts
	sender: UserId;
	state_key?: string;
	type: string;
	unsigned?: UnsignedData;
	redacts?: EventId;
}

/** Minimal state event (used in invites, knocks) */
export interface StrippedStateEvent {
	content: JsonObject;
	sender: UserId;
	state_key: string;
	type: string;
}

/** Event with stream position metadata (internal use) */
export interface StreamEvent {
	event: ClientEvent;
	stream_position: number;
}

/** To-device event */
export interface ToDeviceEvent {
	content: JsonObject;
	sender: UserId;
	type: string;
}
