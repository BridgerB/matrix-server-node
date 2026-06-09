import { globMatch } from "./glob.ts";
import type { Storage } from "./storage/interface.ts";
import type { UserId } from "./types/index.ts";
import type { JsonObject } from "./types/json.ts";

/**
 * MSC4155 invite filtering.
 *
 * A user publishes an invite permission configuration in their *global*
 * account data under the (unstable) type `org.matrix.msc4155.invite_permission_config`.
 * When someone tries to invite that user, the server consults the target's
 * config and decides whether the inviting user is ALLOWed, IGNOREd or BLOCKed.
 *
 * Reference: https://github.com/matrix-org/matrix-spec-proposals/pull/4155
 * (mirrors synapse's `MSC4155InviteRulesConfig`, storage/invite_rule.py).
 */

/** Unstable account-data type carrying the invite permission config (MSC4155). */
export const INVITE_FILTER_ACCOUNT_DATA_TYPE =
	"org.matrix.msc4155.invite_permission_config";

export type InviteRule = "allow" | "ignore" | "block";

/**
 * Evaluate the MSC4155 rules for `inviterUserId` against an account-data
 * config object. Returns the matching rule, defaulting to "allow" when nothing
 * matches (or the config is empty/absent).
 *
 * Precedence (mirrors synapse exactly): user rules are always evaluated before
 * server rules, and within each group the order is allow -> ignore -> block.
 * The first pattern that matches wins. Glob patterns use `*` (any run) and `?`
 * (single char); matching is fully anchored. Non-string / empty entries and
 * non-array fields are ignored.
 */
export const getInviteRule = (
	config: JsonObject | undefined,
	inviterUserId: string,
): InviteRule => {
	if (!config) return "allow";

	const inviterServer = inviterUserId.includes(":")
		? inviterUserId.split(":").slice(1).join(":")
		: "";

	const matchAny = (field: unknown, value: string): boolean => {
		if (!Array.isArray(field)) return false;
		for (const pattern of field) {
			if (typeof pattern !== "string" || pattern.length === 0) continue;
			// User IDs cannot exceed 255 bytes; skip oversized patterns (synapse).
			if (pattern.length > 255) continue;
			try {
				if (globMatch(pattern, value)) return true;
			} catch {
				// Ignore patterns that can't be compiled, matching synapse.
			}
		}
		return false;
	};

	// User rules first, in allow -> ignore -> block order.
	if (matchAny(config.allowed_users, inviterUserId)) return "allow";
	if (matchAny(config.ignored_users, inviterUserId)) return "ignore";
	if (matchAny(config.blocked_users, inviterUserId)) return "block";

	// Then server rules, again allow -> ignore -> block.
	if (inviterServer) {
		if (matchAny(config.allowed_servers, inviterServer)) return "allow";
		if (matchAny(config.ignored_servers, inviterServer)) return "ignore";
		if (matchAny(config.blocked_servers, inviterServer)) return "block";
	}

	return "allow";
};

/**
 * Load the (local) target user's MSC4155 invite permission config from their
 * global account data and return the rule that applies to `inviterUserId`.
 * Returns "allow" when the target has no config (current default behaviour).
 */
export const getInviteRuleForTarget = async (
	storage: Storage,
	targetUserId: UserId,
	inviterUserId: string,
): Promise<InviteRule> => {
	const config = await storage.getGlobalAccountData(
		targetUserId,
		INVITE_FILTER_ACCOUNT_DATA_TYPE,
	);
	return getInviteRule(config, inviterUserId);
};
