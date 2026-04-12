import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { generateToken } from "../crypto.ts";
import { forbidden, missingParam } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";

/** SSO configuration read from environment variables */
export interface SsoConfig {
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

/** Try to build SSO config from env vars; returns undefined if not configured */
export const getSsoConfig = (): SsoConfig | undefined => {
	const issuer = process.env.SSO_ISSUER;
	const clientId = process.env.SSO_CLIENT_ID;
	const clientSecret = process.env.SSO_CLIENT_SECRET;
	const redirectUri = process.env.SSO_REDIRECT_URI;

	if (!issuer || !clientId || !clientSecret || !redirectUri) return undefined;

	return { issuer, clientId, clientSecret, redirectUri };
};

/**
 * Temporary store for SSO state parameters.
 * Maps state → { redirectUrl, expiresAt }
 */
const ssoStateStore = new Map<
	string,
	{ redirectUrl: string; expiresAt: number }
>();

/**
 * Temporary store for login tokens (single-use).
 * Maps token → { userId, expiresAt }
 */
export const loginTokenStore = new Map<
	string,
	{ userId: UserId; expiresAt: number }
>();

/** Clean up expired entries from a store */
const cleanExpired = <V extends { expiresAt: number }>(
	store: Map<string, V>,
): void => {
	const now = Date.now();
	for (const [key, val] of store) {
		if (val.expiresAt < now) store.delete(key);
	}
};

/**
 * GET /_matrix/client/v3/login/sso/redirect
 * GET /_matrix/client/v3/login/sso/redirect/:idpId
 *
 * Redirects user to the OIDC authorization endpoint.
 */
export const getSsoRedirect =
	(ssoConfig: SsoConfig): Handler =>
	async (req) => {
		const redirectUrl = req.query.get("redirectUrl");
		if (!redirectUrl) throw missingParam("Missing required 'redirectUrl' query parameter");

		cleanExpired(ssoStateStore);

		const state = generateToken();
		ssoStateStore.set(state, {
			redirectUrl,
			expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
		});

		// Build OIDC authorization URL
		const issuer = ssoConfig.issuer.replace(/\/$/, "");
		const authUrl = new URL(`${issuer}/authorize`);
		authUrl.searchParams.set("client_id", ssoConfig.clientId);
		authUrl.searchParams.set("redirect_uri", ssoConfig.redirectUri);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("scope", "openid profile email");
		authUrl.searchParams.set("state", state);

		return {
			status: 302,
			body: "",
			headers: {
				Location: authUrl.toString(),
			},
		};
	};

/**
 * Makes an HTTPS (or HTTP for localhost) POST request with form-urlencoded body.
 */
const postFormUrlEncoded = (
	url: string,
	params: Record<string, string>,
): Promise<{ status: number; body: unknown }> => {
	const parsed = new URL(url);
	const bodyStr = new URLSearchParams(params).toString();
	const isHttp = parsed.protocol === "http:";

	const opts: RequestOptions = {
		hostname: parsed.hostname,
		port: parsed.port || (isHttp ? 80 : 443),
		path: parsed.pathname + parsed.search,
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Content-Length": Buffer.byteLength(bodyStr),
		},
		timeout: 30000,
		rejectUnauthorized: false,
	};

	const makeRequest = isHttp ? httpRequest : httpsRequest;

	return new Promise((resolve, reject) => {
		const req = makeRequest(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					parsed = raw;
				}
				resolve({ status: res.statusCode ?? 500, body: parsed });
			});
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("OIDC token request timeout"));
		});
		req.write(bodyStr);
		req.end();
	});
};

/**
 * Decode a JWT payload without signature verification.
 * JWTs are base64url-encoded segments separated by dots.
 */
const decodeJwtPayload = (jwt: string): Record<string, unknown> => {
	const parts = jwt.split(".");
	const payload = parts[1];
	if (!payload) throw new Error("Invalid JWT: missing payload");

	// base64url → base64 → Buffer → JSON
	const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const json = Buffer.from(padded, "base64").toString("utf-8");
	return JSON.parse(json) as Record<string, unknown>;
};

/**
 * GET /_matrix/client/v3/login/sso/callback
 *
 * OIDC callback endpoint. Exchanges auth code for tokens,
 * extracts user info, generates a login token, and redirects
 * back to the client's redirectUrl.
 */
export const getSsoCallback =
	(storage: Storage, serverName: string, ssoConfig: SsoConfig): Handler =>
	async (req) => {
		const code = req.query.get("code");
		const state = req.query.get("state");

		if (!code) throw missingParam("Missing 'code' query parameter");
		if (!state) throw missingParam("Missing 'state' query parameter");

		cleanExpired(ssoStateStore);

		const stateEntry = ssoStateStore.get(state);
		if (!stateEntry) throw forbidden("Invalid or expired SSO state");
		ssoStateStore.delete(state);

		// Exchange authorization code for tokens
		const issuer = ssoConfig.issuer.replace(/\/$/, "");
		const tokenUrl = `${issuer}/token`;

		const tokenResponse = await postFormUrlEncoded(tokenUrl, {
			grant_type: "authorization_code",
			code,
			redirect_uri: ssoConfig.redirectUri,
			client_id: ssoConfig.clientId,
			client_secret: ssoConfig.clientSecret,
		});

		if (tokenResponse.status !== 200) {
			throw forbidden("Failed to exchange authorization code with OIDC provider");
		}

		const tokenBody = tokenResponse.body as Record<string, unknown>;
		const idToken = tokenBody.id_token as string | undefined;
		if (!idToken) {
			throw forbidden("OIDC provider did not return an id_token");
		}

		// Decode the JWT payload (no signature verification for simplicity)
		const claims = decodeJwtPayload(idToken);
		const sub = claims.sub as string | undefined;
		if (!sub) {
			throw forbidden("OIDC id_token missing 'sub' claim");
		}

		// Derive a localpart from OIDC claims
		const preferredUsername = claims.preferred_username as string | undefined;
		const email = claims.email as string | undefined;

		// Sanitize the localpart: use preferred_username, email prefix, or sub
		let localpart = (preferredUsername ?? email?.split("@")[0] ?? sub)
			.toLowerCase()
			.replace(/[^a-z0-9._=\-/]/g, "_");

		// Ensure the user exists (auto-register from SSO if needed)
		let account = await storage.getUserByLocalpart(localpart);
		if (!account) {
			// Check if sub-based user exists (dedup by sub)
			const subLocalpart = `sso_${sub.toLowerCase().replace(/[^a-z0-9._=\-/]/g, "_")}`;
			account = await storage.getUserByLocalpart(subLocalpart);
			if (!account) {
				// If the preferred localpart is taken, fall back to sub-based
				const existingPreferred = await storage.getUserByLocalpart(localpart);
				if (existingPreferred) {
					localpart = subLocalpart;
				}

				const userId = `@${localpart}:${serverName}` as UserId;
				await storage.createUser({
					user_id: userId,
					localpart,
					server_name: serverName,
					password_hash: "", // SSO users have no password
					account_type: "user",
					is_deactivated: false,
					created_at: Date.now(),
					displayname: (claims.name as string | undefined) ?? preferredUsername,
				});
				account = await storage.getUserByLocalpart(localpart);
			}
		}

		if (!account) {
			throw forbidden("Failed to create or find SSO user");
		}

		if (account.is_deactivated) {
			throw forbidden("This account has been deactivated");
		}

		// Generate a single-use login token
		cleanExpired(loginTokenStore);

		const loginToken = generateToken();
		loginTokenStore.set(loginToken, {
			userId: account.user_id as UserId,
			expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes
		});

		// Redirect back to the client with the login token
		const redirectTarget = new URL(stateEntry.redirectUrl);
		redirectTarget.searchParams.set("loginToken", loginToken);

		return {
			status: 302,
			body: "",
			headers: {
				Location: redirectTarget.toString(),
			},
		};
	};

/**
 * GET /_matrix/client/v3/auth/m.login.sso/fallback/web
 *
 * Returns a simple HTML page that redirects to SSO login.
 * Used for UIAA SSO fallback.
 */
export const getSsoFallback =
	(ssoConfig: SsoConfig): Handler =>
	async (req) => {
		const session = req.query.get("session");
		if (!session) throw missingParam("Missing 'session' query parameter");

		const html = `<!DOCTYPE html>
<html>
<head><title>SSO Login</title></head>
<body>
<h1>Single Sign-On</h1>
<p>Click the button below to log in with your SSO provider.</p>
<a href="/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(ssoConfig.redirectUri)}">
  <button>Sign in with SSO</button>
</a>
</body>
</html>`;

		return {
			status: 200,
			body: Buffer.from(html, "utf-8"),
			headers: {
				"Content-Type": "text/html; charset=utf-8",
			},
		};
	};
