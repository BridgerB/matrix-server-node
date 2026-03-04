import type { ServerName } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";

const globMatch = (pattern: string, value: string) =>
	new RegExp(
		`^${pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".")}$`,
	).test(value);

export const isServerAllowedByAcl = (
	serverName: ServerName,
	roomState: RoomState,
): boolean => {
	const aclEvent = roomState.state_events.get("m.room.server_acl\0");
	if (!aclEvent) return true;

	const content = aclEvent.content as Record<string, unknown>;
	const allow = (content.allow ?? []) as string[];
	const deny = (content.deny ?? []) as string[];
	const allowIpLiterals = content.allow_ip_literals !== false;

	if (
		!allowIpLiterals &&
		(/^\d+\.\d+\.\d+\.\d+$/.test(serverName) || serverName.startsWith("["))
	)
		return false;

	if (deny.some((pattern) => globMatch(pattern, serverName))) return false;
	if (allow.some((pattern) => globMatch(pattern, serverName))) return true;

	return false;
};
