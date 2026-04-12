import type { Storage } from "./storage/interface.ts";
import type { UserId } from "./types/index.ts";

/**
 * Returns the set of senders whose invites should be suppressed,
 * based on the user's `m.ignored_invites` global account data.
 *
 * Expected format:
 * ```json
 * { "senders": { "@baduser:server": {} } }
 * ```
 */
export const getIgnoredInviteSenders = async (
	storage: Storage,
	userId: UserId,
): Promise<Set<UserId>> => {
	const data = await storage.getGlobalAccountData(
		userId,
		"m.ignored_invites",
	);
	if (!data) return new Set();
	const content = data as Record<string, unknown>;
	const senders = content.senders as Record<string, unknown> | undefined;
	if (!senders || typeof senders !== "object") return new Set();
	return new Set(Object.keys(senders) as UserId[]);
};
