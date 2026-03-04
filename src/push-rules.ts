import type { UserId } from "./types/identifiers.ts";
import type { PDU } from "./types/events.ts";
import type {
	PushRulesContent,
	PushCondition,
	PushAction,
} from "./types/push.ts";
import type { RoomPowerLevelsContent } from "./types/state-events.ts";
import type { JsonValue, JsonObject } from "./types/json.ts";
import type { Storage } from "./storage/interface.ts";

// =============================================================================
// TYPES
// =============================================================================

export interface EvaluationContext {
	event: PDU;
	userId: UserId;
	displayName?: string;
	memberCount: number;
	powerLevels?: RoomPowerLevelsContent;
	senderPowerLevel: number;
}

export interface PushEvalResult {
	notify: boolean;
	highlight: boolean;
	sound?: string;
}

export type PushRuleKind =
	| "override"
	| "content"
	| "room"
	| "sender"
	| "underride";

const VALID_KINDS = new Set<string>([
	"override",
	"content",
	"room",
	"sender",
	"underride",
]);

export function isValidKind(kind: string): kind is PushRuleKind {
	return VALID_KINDS.has(kind);
}

// =============================================================================
// DEFAULT PUSH RULES
// =============================================================================

export function getDefaultRules(userId: UserId): PushRulesContent {
	return {
		global: {
			override: [
				{
					rule_id: ".m.rule.master",
					default: true,
					enabled: false,
					conditions: [],
					actions: [],
				},
				{
					rule_id: ".m.rule.suppress_notices",
					default: true,
					enabled: true,
					conditions: [
						{
							kind: "event_match",
							key: "content.msgtype",
							pattern: "m.notice",
						},
					],
					actions: ["dont_notify"],
				},
				{
					rule_id: ".m.rule.invite_for_me",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.room.member" },
						{
							kind: "event_match",
							key: "content.membership",
							pattern: "invite",
						},
						{ kind: "event_match", key: "state_key", pattern: userId },
					],
					actions: ["notify", { set_tweak: "sound", value: "default" }],
				},
				{
					rule_id: ".m.rule.member_event",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.room.member" },
					],
					actions: ["dont_notify"],
				},
				{
					rule_id: ".m.rule.is_user_mention",
					default: true,
					enabled: true,
					conditions: [
						{
							kind: "event_property_contains",
							key: "content.m\\.mentions.user_ids",
							value: userId,
						},
					],
					actions: [
						"notify",
						{ set_tweak: "sound", value: "default" },
						{ set_tweak: "highlight" },
					],
				},
				{
					rule_id: ".m.rule.is_room_mention",
					default: true,
					enabled: true,
					conditions: [
						{
							kind: "event_property_is",
							key: "content.m\\.mentions.room",
							value: true,
						},
						{ kind: "sender_notification_permission", key: "room" },
					],
					actions: ["notify", { set_tweak: "highlight" }],
				},
				{
					rule_id: ".m.rule.tombstone",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.room.tombstone" },
						{ kind: "event_match", key: "state_key", pattern: "" },
					],
					actions: ["notify", { set_tweak: "highlight" }],
				},
				{
					rule_id: ".m.rule.roomnotif",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "content.body", pattern: "@room" },
						{ kind: "sender_notification_permission", key: "room" },
					],
					actions: ["notify", { set_tweak: "highlight" }],
				},
			],
			content: [
				{
					rule_id: ".m.rule.contains_display_name",
					default: true,
					enabled: true,
					conditions: [{ kind: "contains_display_name" }],
					actions: [
						"notify",
						{ set_tweak: "sound", value: "default" },
						{ set_tweak: "highlight" },
					],
				},
			],
			room: [],
			sender: [],
			underride: [
				{
					rule_id: ".m.rule.call",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.call.invite" },
					],
					actions: ["notify", { set_tweak: "sound", value: "ring" }],
				},
				{
					rule_id: ".m.rule.encrypted_room_one_to_one",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "room_member_count", is: "2" },
						{ kind: "event_match", key: "type", pattern: "m.room.encrypted" },
					],
					actions: ["notify", { set_tweak: "sound", value: "default" }],
				},
				{
					rule_id: ".m.rule.room_one_to_one",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "room_member_count", is: "2" },
						{ kind: "event_match", key: "type", pattern: "m.room.message" },
					],
					actions: ["notify", { set_tweak: "sound", value: "default" }],
				},
				{
					rule_id: ".m.rule.message",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.room.message" },
					],
					actions: ["notify"],
				},
				{
					rule_id: ".m.rule.encrypted",
					default: true,
					enabled: true,
					conditions: [
						{ kind: "event_match", key: "type", pattern: "m.room.encrypted" },
					],
					actions: ["notify"],
				},
			],
		},
	};
}

// =============================================================================
// LAZY INIT / PERSISTENCE
// =============================================================================

export async function getOrInitRules(
	storage: Storage,
	userId: UserId,
): Promise<PushRulesContent> {
	const existing = await storage.getGlobalAccountData(userId, "m.push_rules");
	if (existing) return existing as unknown as PushRulesContent;

	const defaults = getDefaultRules(userId);
	await storage.setGlobalAccountData(
		userId,
		"m.push_rules",
		defaults as unknown as JsonObject,
	);
	return defaults;
}

export async function saveRules(
	storage: Storage,
	userId: UserId,
	rules: PushRulesContent,
): Promise<void> {
	await storage.setGlobalAccountData(
		userId,
		"m.push_rules",
		rules as unknown as JsonObject,
	);
}

// =============================================================================
// PUSH RULE EVALUATOR
// =============================================================================

export function evaluatePushRules(
	rules: PushRulesContent,
	ctx: EvaluationContext,
): PushEvalResult {
	const noMatch: PushEvalResult = { notify: false, highlight: false };

	// Skip own events
	if (ctx.event.sender === ctx.userId) return noMatch;

	const ruleset = rules.global;

	// Check override rules
	for (const rule of ruleset.override ?? []) {
		if (!rule.enabled) continue;
		if (checkConditions(rule.conditions ?? [], ctx))
			return parseActions(rule.actions);
	}

	// Check content rules
	for (const rule of ruleset.content ?? []) {
		if (!rule.enabled) continue;
		// Content rules can use conditions (e.g. contains_display_name) or pattern
		if (rule.conditions && rule.conditions.length > 0) {
			if (checkConditions(rule.conditions, ctx))
				return parseActions(rule.actions);
		} else if (rule.pattern) {
			const body = getNestedValue(ctx.event, "content.body");
			if (
				typeof body === "string" &&
				globMatchWordBoundary(rule.pattern, body)
			) {
				return parseActions(rule.actions);
			}
		}
	}

	// Check room rules
	for (const rule of ruleset.room ?? []) {
		if (!rule.enabled) continue;
		if (ctx.event.room_id === rule.rule_id) return parseActions(rule.actions);
	}

	// Check sender rules
	for (const rule of ruleset.sender ?? []) {
		if (!rule.enabled) continue;
		if (ctx.event.sender === rule.rule_id) return parseActions(rule.actions);
	}

	// Check underride rules
	for (const rule of ruleset.underride ?? []) {
		if (!rule.enabled) continue;
		if (checkConditions(rule.conditions ?? [], ctx))
			return parseActions(rule.actions);
	}

	return noMatch;
}

// =============================================================================
// CONDITION MATCHERS
// =============================================================================

function checkConditions(
	conditions: PushCondition[],
	ctx: EvaluationContext,
): boolean {
	return conditions.every((c) => checkCondition(c, ctx));
}

function checkCondition(cond: PushCondition, ctx: EvaluationContext): boolean {
	switch (cond.kind) {
		case "event_match": {
			if (!cond.key || cond.pattern === undefined) return false;
			const value = getNestedValue(ctx.event, cond.key);
			if (typeof value !== "string") return false;
			// content.body uses word-boundary matching
			if (cond.key === "content.body") {
				return globMatchWordBoundary(cond.pattern, value);
			}
			return globMatch(cond.pattern, value);
		}

		case "contains_display_name": {
			if (!ctx.displayName) return false;
			const body = getNestedValue(ctx.event, "content.body");
			if (typeof body !== "string") return false;
			return globMatchWordBoundary(ctx.displayName, body);
		}

		case "room_member_count": {
			if (!cond.is) return false;
			return matchMemberCount(ctx.memberCount, cond.is);
		}

		case "sender_notification_permission": {
			if (!cond.key) return false;
			const threshold =
				ctx.powerLevels?.notifications?.[cond.key as "room"] ?? 50;
			return ctx.senderPowerLevel >= threshold;
		}

		case "event_property_is": {
			if (!cond.key) return false;
			const value = getNestedValue(ctx.event, cond.key);
			return jsonValueEquals(value as JsonValue, cond.value);
		}

		case "event_property_contains": {
			if (!cond.key) return false;
			const value = getNestedValue(ctx.event, cond.key);
			if (!Array.isArray(value)) return false;
			return value.some((item) =>
				jsonValueEquals(item as JsonValue, cond.value),
			);
		}

		default:
			return false;
	}
}

// =============================================================================
// HELPERS
// =============================================================================

function getNestedValue(obj: unknown, key: string): unknown {
	// Parse dot-separated path, handling escaped dots (\.)
	const parts: string[] = [];
	let current = "";
	for (let i = 0; i < key.length; i++) {
		if (key[i] === "\\" && i + 1 < key.length && key[i + 1] === ".") {
			current += ".";
			i++; // skip the dot
		} else if (key[i] === ".") {
			parts.push(current);
			current = "";
		} else {
			current += key[i];
		}
	}
	parts.push(current);

	let value: unknown = obj;
	for (const part of parts) {
		if (value === null || value === undefined || typeof value !== "object")
			return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

function globMatch(pattern: string, value: string): boolean {
	// Convert glob pattern to regex: * -> .*, ? -> .
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const regex = new RegExp(`^${escaped}$`, "i");
	return regex.test(value);
}

function globMatchWordBoundary(pattern: string, body: string): boolean {
	// Word-boundary aware matching for content.body
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const regex = new RegExp(`(?:^|\\W)(${escaped})(?:$|\\W)`, "i");
	return regex.test(body);
}

function matchMemberCount(actual: number, is: string): boolean {
	const match = is.match(/^(==|<=|>=|<|>)?(\d+)$/);
	if (!match) return false;
	const op = match[1] || "==";
	const target = parseInt(match[2]!, 10);
	switch (op) {
		case "==":
			return actual === target;
		case "<":
			return actual < target;
		case ">":
			return actual > target;
		case "<=":
			return actual <= target;
		case ">=":
			return actual >= target;
		default:
			return false;
	}
}

function parseActions(actions: PushAction[]): PushEvalResult {
	const result: PushEvalResult = { notify: false, highlight: false };
	for (const action of actions) {
		if (action === "notify") {
			result.notify = true;
		} else if (action === "dont_notify") {
			result.notify = false;
		} else if (typeof action === "object") {
			if (action.set_tweak === "highlight") {
				result.highlight = action.value !== false;
			} else if (action.set_tweak === "sound") {
				result.sound = action.value;
			}
		}
	}
	return result;
}

function jsonValueEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
	return false;
}
