import type { Handler } from "../router.ts";
import type { VersionsResponse, WellKnown } from "../types/index.ts";
import { getSsoConfig } from "./sso.ts";

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
			"v1.15",
			"v1.16",
			"v1.17",
			"v1.18",
		],
		unstable_features: {
			"org.matrix.msc3765.rich_topic": true,
			"org.matrix.msc3916.stable": true,
		},
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
	return async () => {
		const ssoConfig = getSsoConfig();
		if (!ssoConfig) {
			return {
				status: 404,
				body: {
					errcode: "M_UNRECOGNIZED",
					error: "SSO/OIDC is not configured on this server",
				},
			};
		}

		const issuer = ssoConfig.issuer.replace(/\/$/, "");
		return {
			status: 200,
			body: {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				registration_endpoint: `${issuer}/register`,
				account_management_uri: `${issuer}/account`,
				account_management_actions_supported: [
					"org.matrix.profile",
					"org.matrix.sessions_list",
					"org.matrix.session_view",
					"org.matrix.session_end",
					"org.matrix.cross_signing_reset",
				],
			},
		};
	};
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
					"12": "stable",
				},
			},
			"m.profile_fields": {
				enabled: true,
			},
		},
	};
	return () => ({ status: 200, body });
};
