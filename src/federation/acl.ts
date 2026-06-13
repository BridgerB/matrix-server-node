import { globMatch } from "../glob.ts";
import type { ServerName } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";

const isIpLiteral = (serverName: string): boolean =>
	/^\d+\.\d+\.\d+\.\d+$/.test(serverName) || serverName.startsWith("[");

export const isServerAllowedByAcl = (
	serverName: ServerName,
	roomState: RoomState,
): boolean => {
	const aclEvent = roomState.state_events.get("m.room.server_acl\x1f");
	if (!aclEvent) return true;

	const content = aclEvent.content as Record<string, unknown>;
	const allow = (content.allow ?? []) as readonly string[];
	const deny = (content.deny ?? []) as readonly string[];
	const allowIpLiterals = content.allow_ip_literals !== false;

	if (!allowIpLiterals && isIpLiteral(serverName)) return false;
	if (deny.some((pattern) => globMatch(pattern, serverName))) return false;
	return allow.some((pattern) => globMatch(pattern, serverName));
};
