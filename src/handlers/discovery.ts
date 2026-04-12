import type { Handler } from "../router.ts";
import type { VersionsResponse, WellKnown } from "../types/index.ts";

export const versionsHandler = (_serverName: string): Handler => {
	const body: VersionsResponse = {
		versions: [
			"v1.1",
			"v1.2",
			"v1.3",
			"v1.4",
			"v1.5",
			"v1.6",
			"v1.7",
			"v1.8",
			"v1.9",
			"v1.10",
			"v1.11",
			"v1.12",
			"v1.13",
			"v1.14",
		],
		unstable_features: {},
	};
	return async () => ({ status: 200, body });
};

export const wellKnownServerHandler = (serverName: string): Handler => {
	const body = { "m.server": `${serverName}:8448` };
	return async () => ({ status: 200, body });
};

export const wellKnownClientHandler = (serverName: string): Handler => {
	const body: WellKnown = {
		"m.homeserver": { base_url: `https://${serverName}` },
	};
	return async () => ({ status: 200, body });
};

export const wellKnownSupportHandler = (): Handler => {
	return async () => ({ status: 200, body: { contacts: [] } });
};

export const wellKnownPolicyServerHandler = (): Handler => {
	return async () => ({
		status: 404,
		body: { errcode: "M_NOT_FOUND", error: "No policy server configured" },
	});
};

export const getAuthMetadata = (): Handler => {
	return async () => ({
		status: 404,
		body: {
			errcode: "M_UNRECOGNIZED",
			error: "SSO/OIDC is not configured on this server",
		},
	});
};

export const getCapabilities = (): Handler => {
	const body = {
		capabilities: {
			"m.change_password": { enabled: true },
			"m.room_versions": {
				default: "10",
				available: {
					"1": "stable",
					"2": "stable",
					"3": "stable",
					"4": "stable",
					"5": "stable",
					"6": "stable",
					"7": "stable",
					"8": "stable",
					"9": "stable",
					"10": "stable",
					"11": "stable",
				},
			},
		},
	};
	return () => ({ status: 200, body });
};
