import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { PushRuleset, PushRule, PushAction } from "../types/push.ts";
import { getOrInitRules, saveRules, isValidKind } from "../push-rules.ts";
import type { PushRuleKind } from "../push-rules.ts";
import { badJson, notFound, forbidden } from "../errors.ts";

// =============================================================================
// HELPERS
// =============================================================================

function getRulesForKind(ruleset: PushRuleset, kind: PushRuleKind): PushRule[] {
  return ruleset[kind] ?? [];
}

function findRule(rules: PushRule[], ruleId: string): PushRule | undefined {
  return rules.find((r) => r.rule_id === ruleId);
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/
// =============================================================================

export function getAllPushRules(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const rules = await getOrInitRules(storage, userId);
    return { status: 200, body: { global: rules.global } };
  };
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/global/
// =============================================================================

export function getGlobalPushRules(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const rules = await getOrInitRules(storage, userId);
    return { status: 200, body: rules.global };
  };
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/global/:kind/
// =============================================================================

export function getPushRulesByKind(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const rules = await getOrInitRules(storage, userId);
    return { status: 200, body: getRulesForKind(rules.global, kind) };
  };
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/global/:kind/:ruleId
// =============================================================================

export function getPushRule(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const rules = await getOrInitRules(storage, userId);
    const kindRules = getRulesForKind(rules.global, kind);
    const rule = findRule(kindRules, ruleId);
    if (!rule) throw notFound("Rule not found");

    return { status: 200, body: rule };
  };
}

// =============================================================================
// PUT /_matrix/client/v3/pushrules/global/:kind/:ruleId
// =============================================================================

export function putPushRule(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]! as PushRuleKind;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    // Cannot create rules with server-default prefix
    if (ruleId.startsWith(".")) {
      throw badJson("Cannot create rules with '.' prefix (reserved for defaults)");
    }

    const body = (req.body ?? {}) as {
      actions?: PushAction[];
      conditions?: unknown[];
      pattern?: string;
    };

    if (!body.actions || !Array.isArray(body.actions)) {
      throw badJson("Missing or invalid 'actions' field");
    }

    const newRule: PushRule = {
      rule_id: ruleId,
      default: false,
      enabled: true,
      actions: body.actions,
    };

    if (kind === "content") {
      if (!body.pattern || typeof body.pattern !== "string") {
        throw badJson("Content rules require a 'pattern' field");
      }
      newRule.pattern = body.pattern;
    } else if (kind === "override" || kind === "underride") {
      newRule.conditions = (body.conditions ?? []) as PushRule["conditions"];
    }
    // room and sender rules don't need conditions or pattern

    const rules = await getOrInitRules(storage, userId);
    const kindRules = getRulesForKind(rules.global, kind);

    // Check for before/after positioning
    const before = req.query.get("before");
    const after = req.query.get("after");

    // Remove existing rule with same ID if present
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
      // Insert before default rules
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
}

// =============================================================================
// DELETE /_matrix/client/v3/pushrules/global/:kind/:ruleId
// =============================================================================

export function deletePushRule(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]! as PushRuleKind;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const rules = await getOrInitRules(storage, userId);
    const kindRules = getRulesForKind(rules.global, kind);
    const idx = kindRules.findIndex((r) => r.rule_id === ruleId);
    if (idx < 0) throw notFound("Rule not found");

    if (kindRules[idx]!.default) {
      throw forbidden("Cannot delete default rules");
    }

    kindRules.splice(idx, 1);
    rules.global[kind] = kindRules;
    await saveRules(storage, userId, rules);
    return { status: 200, body: {} };
  };
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled
// =============================================================================

export function getPushRuleEnabled(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const rules = await getOrInitRules(storage, userId);
    const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
    if (!rule) throw notFound("Rule not found");

    return { status: 200, body: { enabled: rule.enabled } };
  };
}

// =============================================================================
// PUT /_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled
// =============================================================================

export function putPushRuleEnabled(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      throw badJson("Missing or invalid 'enabled' field");
    }

    const rules = await getOrInitRules(storage, userId);
    const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
    if (!rule) throw notFound("Rule not found");

    rule.enabled = body.enabled;
    await saveRules(storage, userId, rules);
    return { status: 200, body: {} };
  };
}

// =============================================================================
// GET /_matrix/client/v3/pushrules/global/:kind/:ruleId/actions
// =============================================================================

export function getPushRuleActions(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const rules = await getOrInitRules(storage, userId);
    const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
    if (!rule) throw notFound("Rule not found");

    return { status: 200, body: { actions: rule.actions } };
  };
}

// =============================================================================
// PUT /_matrix/client/v3/pushrules/global/:kind/:ruleId/actions
// =============================================================================

export function putPushRuleActions(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const kind = req.params["kind"]!;
    const ruleId = req.params["ruleId"]!;
    if (!isValidKind(kind)) throw notFound("Unknown rule kind");

    const body = (req.body ?? {}) as { actions?: PushAction[] };
    if (!body.actions || !Array.isArray(body.actions)) {
      throw badJson("Missing or invalid 'actions' field");
    }

    const rules = await getOrInitRules(storage, userId);
    const rule = findRule(getRulesForKind(rules.global, kind), ruleId);
    if (!rule) throw notFound("Rule not found");

    rule.actions = body.actions;
    await saveRules(storage, userId, rules);
    return { status: 200, body: {} };
  };
}
