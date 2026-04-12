import type { Storage } from "./storage/interface.ts";
import type { IgnoredUserListContent } from "./types/account-data.ts";
import type { UserId } from "./types/index.ts";

export const getIgnoredUsers = async (
	storage: Storage,
	userId: UserId,
): Promise<Set<UserId>> => {
	const data = await storage.getGlobalAccountData(
		userId,
		"m.ignored_user_list",
	);
	if (!data) return new Set();
	const content = data as unknown as IgnoredUserListContent;
	if (!content.ignored_users) return new Set();
	return new Set(Object.keys(content.ignored_users) as UserId[]);
};
