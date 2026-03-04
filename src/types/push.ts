// =============================================================================
// PUSH RULES
// =============================================================================

import type { EventId, RoomId, UserId, RoomAlias } from "./identifiers.ts";
import type { JsonObject, JsonValue } from "./json.ts";

export interface PushRulesContent {
	global: PushRuleset;
}

export interface PushRuleset {
	override?: PushRule[];
	content?: PushRule[];
	room?: PushRule[];
	sender?: PushRule[];
	underride?: PushRule[];
}

export interface PushRule {
	rule_id: string;
	default: boolean;
	enabled: boolean;
	conditions?: PushCondition[];
	actions: PushAction[];
	pattern?: string; // for content rules
}

export interface PushCondition {
	kind:
		| "event_match"
		| "event_property_is"
		| "contains_display_name"
		| "room_member_count"
		| "sender_notification_permission"
		| "event_property_contains";
	key?: string;
	pattern?: string;
	is?: string; // for room_member_count comparisons
	value?: JsonValue;
}

export type PushAction =
	| "notify"
	| "dont_notify" // deprecated but still used
	| { set_tweak: "sound"; value: string }
	| { set_tweak: "highlight"; value?: boolean };

export interface Pusher {
	pushkey: string;
	kind: "http" | "email" | null; // null to delete
	app_id: string;
	app_display_name: string;
	device_display_name: string;
	profile_tag?: string;
	lang: string;
	data: {
		url?: string; // for http pushers
		format?: string; // "event_id_only"
		brand?: string; // for email
	};
	append?: boolean;
}

export interface PushNotification {
	notification: {
		event_id?: EventId;
		room_id?: RoomId;
		type?: string;
		sender?: UserId;
		sender_display_name?: string;
		room_name?: string;
		room_alias?: RoomAlias;
		prio: "high" | "low";
		content?: JsonObject;
		counts: {
			unread: number;
			missed_calls?: number;
		};
		devices: {
			app_id: string;
			pushkey: string;
			pushkey_ts?: number;
			data: JsonObject;
			tweaks: Record<string, JsonValue>;
		}[];
	};
}
