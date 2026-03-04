import type { ServerName } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";

export function isServerAllowedByAcl(
	serverName: ServerName,
	roomState: RoomState,
): boolean {
	const aclEvent = roomState.state_events.get("m.room.server_acl\0");
	if (!aclEvent) return true; // No ACL = all allowed

	const content = aclEvent.content as Record<string, unknown>;
	const allow = (content.allow ?? []) as string[];
	const deny = (content.deny ?? []) as string[];
	const allowIpLiterals = content.allow_ip_literals !== false;

	// Check IP literal restriction
	if (!allowIpLiterals) {
		if (/^\d+\.\d+\.\d+\.\d+$/.test(serverName) || serverName.startsWith("[")) {
			return false;
		}
	}

	// Check deny list first
	for (const pattern of deny) {
		if (globMatch(pattern, serverName)) return false;
	}

	// Check allow list
	for (const pattern of allow) {
		if (globMatch(pattern, serverName)) return true;
	}

	// Default deny if allow list is present but no match
	return false;
}

function globMatch(pattern: string, value: string): boolean {
	// Convert glob pattern to regex
	// * matches any sequence of characters, ? matches single character
	const regex = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".") +
			"$",
	);
	return regex.test(value);
}
