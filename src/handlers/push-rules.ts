import { badJson, forbidden, notFound } from "../errors.ts";
import type { PushRuleKind } from "../push-rules.ts";
import { getOrInitRules, isValidKind, saveRules } from "../push-rules.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { PushAction, PushRule, PushRuleset } from "../types/push.ts";

const getRulesForKind = (
	ruleset: PushRuleset,
	kind: PushRuleKind,
): PushRule[] => ruleset[kind] ?? [];

const findRule = (rules: PushRule[], ruleId: string): PushRule | undefined =>
	rules.find((r) => r.rule_id === ruleId);

export const getAllPushRules =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const rules = await getOrInitRules(storage, userId);
		return { status: 200, body: { global: rules.global } };
	};

export const getGlobalPushRules =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const rules = await getOrInitRules(storage, userId);
		return { status: 200, body: rules.global };
	};

export const getPushRulesByKind =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const rules = await getOrInitRules(storage, userId);
		return { status: 200, body: getRulesForKind(rules.global, kind) };
	};

export const getPushRule =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const rules = await getOrInitRules(storage, userId);
		const kindRules = getRulesForKind(rules.global, kind);
		const rule = findRule(kindRules, ruleId);
		if (!rule) throw notFound("Rule not found");

		return { status: 200, body: rule };
	};

export const putPushRule =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as PushRuleKind;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		if (ruleId.startsWith(".")) {
			throw badJson(
				"Cannot create rules with '.' prefix (reserved for defaults)",
			);
		}

		const body = (req.body ?? {}) as {
			actions?: PushAction[];
			conditions?: unknown[];
			pattern?: string;
		};

		if (!body.actions || !Array.isArray(body.actions))
			throw badJson("Missing or invalid 'actions' field");

		const newRule: PushRule = {
			rule_id: ruleId,
			default: false,
			enabled: true,
			actions: body.actions,
		};

		if (kind === "content") {
			if (!body.pattern || typeof body.pattern !== "string")
				throw badJson("Content rules require a 'pattern' field");
			newRule.pattern = body.pattern;
		} else if (kind === "override" || kind === "underride") {
			newRule.conditions = (body.conditions ?? []) as PushRule["conditions"];
		}

		const rules = await getOrInitRules(storage, userId);
		const kindRules = getRulesForKind(rules.global, kind);

		const before = req.query.get("before");
		const after = req.query.get("after");

		const existingIdx = kindRules.findIndex((r) => r.rule_id === ruleId);
		if (existingIdx >= 0) kindRules.splice(existingIdx, 1);

		if (before) {
			const idx = kindRules.findIndex((r) => r.rule_id === before);
			if (idx < 0) throw notFound("'before' rule not found");
			kindRules.splice(idx, 0, newRule);
		} else if (after) {
			const idx = kindRules.findIndex((r) => r.rule_id === after);
			if (idx < 0) throw notFound("'after' rule not found");
			kindRules.splice(idx + 1, 0, newRule);
		} else {
			const firstDefault = kindRules.findIndex((r) => r.default);
			if (firstDefault >= 0) {
				kindRules.splice(firstDefault, 0, newRule);
			} else {
				kindRules.push(newRule);
			}
		}

		rules.global[kind] = kindRules;
		await saveRules(storage, userId, rules);
		return { status: 200, body: {} };
	};

export const deletePushRule =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as PushRuleKind;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const rules = await getOrInitRules(storage, userId);
		const kindRules = getRulesForKind(rules.global, kind);
		const idx = kindRules.findIndex((r) => r.rule_id === ruleId);
		if (idx < 0) throw notFound("Rule not found");

		if (kindRules[idx]?.default) throw forbidden("Cannot delete default rules");

		kindRules.splice(idx, 1);
		rules.global[kind] = kindRules;
		await saveRules(storage, userId, rules);
		return { status: 200, body: {} };
	};

export const getPushRuleEnabled =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const rules = await getOrInitRules(storage, userId);
		const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
		if (!rule) throw notFound("Rule not found");

		return { status: 200, body: { enabled: rule.enabled } };
	};

export const putPushRuleEnabled =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const body = (req.body ?? {}) as { enabled?: boolean };
		if (typeof body.enabled !== "boolean")
			throw badJson("Missing or invalid 'enabled' field");

		const rules = await getOrInitRules(storage, userId);
		const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
		if (!rule) throw notFound("Rule not found");

		rule.enabled = body.enabled;
		await saveRules(storage, userId, rules);
		return { status: 200, body: {} };
	};

export const getPushRuleActions =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const rules = await getOrInitRules(storage, userId);
		const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
		if (!rule) throw notFound("Rule not found");

		return { status: 200, body: { actions: rule.actions } };
	};

export const putPushRuleActions =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const kind = req.params.kind as string;
		const ruleId = req.params.ruleId as string;
		if (!isValidKind(kind)) throw notFound("Unknown rule kind");

		const body = (req.body ?? {}) as { actions?: PushAction[] };
		if (!body.actions || !Array.isArray(body.actions))
			throw badJson("Missing or invalid 'actions' field");

		const rules = await getOrInitRules(storage, userId);
		const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
		if (!rule) throw notFound("Rule not found");

		rule.actions = body.actions;
		await saveRules(storage, userId, rules);
		return { status: 200, body: {} };
	};
