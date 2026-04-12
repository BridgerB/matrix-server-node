import {
	findAppserviceByToken,
	findAppserviceForUser,
} from "../appservice/registration.ts";
import { generateToken } from "../crypto.ts";
import { verifyPassword } from "../crypto-utils.ts";
import { badJson, forbidden, invalidParam } from "../errors.ts";
import { extractAccessToken } from "../middleware/auth.ts";
import type { Handler, RouterRequest, RouterResponse } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";
import type { LoginFlow, LoginRequest, LoginResponse } from "../types/index.ts";
import { createSessionAndRespond } from "./auth-shared.ts";
import { getSsoConfig, loginTokenStore } from "./sso.ts";

export const getLoginFlows =
	(registrations: AppserviceRegistration[]): Handler =>
	async () => {
		const flows: LoginFlow[] = [{ type: "m.login.password" }];
		if (registrations.length > 0) {
			flows.push({ type: "m.login.application_service" });
		}
		const ssoConfig = getSsoConfig();
		if (ssoConfig) {
			flows.push({
				type: "m.login.sso",
				identity_providers: [
					{ id: "oidc", name: "SSO", brand: "org.matrix.oidc" },
				],
			} as LoginFlow);
			flows.push({ type: "m.login.token" });
			flows.push({ type: "m.oauth" });
		}
		return { status: 200, body: { flows } };
	};

export const postLogin =
	(
		storage: Storage,
		serverName: string,
		registrations: AppserviceRegistration[],
	): Handler =>
	async (req) => {
		const body = req.body as LoginRequest;

		if (!body.type) throw badJson("Missing 'type' field");

		if (body.type === "m.login.token" || body.type === "m.oauth") {
			return handleTokenLogin(storage, serverName, req, body);
		}

		if (body.type === "m.login.application_service") {
			return handleAppserviceLogin(
				storage,
				serverName,
				registrations,
				req,
				body,
			);
		}

		if (body.type !== "m.login.password")
			throw invalidParam(`Unsupported login type: ${body.type}`);

		if (!body.identifier || body.identifier.type !== "m.id.user")
			throw invalidParam("Only m.id.user identifier is supported");

		let localpart = body.identifier.user;
		if (localpart.startsWith("@")) {
			const colonIdx = localpart.indexOf(":");
			localpart =
				colonIdx > 0 ? localpart.slice(1, colonIdx) : localpart.slice(1);
		}

		const account = await storage.getUserByLocalpart(localpart);
		if (!account) throw forbidden("Invalid username or password");
		if (account.is_deactivated)
			throw forbidden("This account has been deactivated");

		const passwordValid = await verifyPassword(
			body.password ?? "",
			account.password_hash,
		);
		if (!passwordValid) {
			throw forbidden("Invalid username or password");
		}

		const { accessToken, deviceId, refreshToken } =
			await createSessionAndRespond(storage, req, account.user_id, body);

		const response: LoginResponse = {
			user_id: account.user_id,
			access_token: accessToken,
			device_id: deviceId,
			well_known: {
				"m.homeserver": { base_url: `https://${serverName}` },
			},
		};

		if (refreshToken) {
			response.refresh_token = refreshToken;
			response.expires_in_ms = 300_000;
		}

		return { status: 200, body: response };
	};

const handleTokenLogin = async (
	storage: Storage,
	serverName: string,
	req: RouterRequest,
	body: LoginRequest,
): Promise<RouterResponse> => {
	const token = body.token;
	if (!token) throw badJson("Missing 'token' field for m.login.token");

	const entry = loginTokenStore.get(token);
	if (!entry) throw forbidden("Invalid or expired login token");

	loginTokenStore.delete(token);

	if (entry.expiresAt < Date.now()) {
		throw forbidden("Login token has expired");
	}

	const account = await storage.getUserById(entry.userId);
	if (!account) throw forbidden("User not found");
	if (account.is_deactivated)
		throw forbidden("This account has been deactivated");

	const { accessToken, deviceId, refreshToken } =
		await createSessionAndRespond(storage, req, account.user_id, body);

	const response: LoginResponse = {
		user_id: account.user_id,
		access_token: accessToken,
		device_id: deviceId,
		well_known: {
			"m.homeserver": { base_url: `https://${serverName}` },
		},
	};

	if (refreshToken) {
		response.refresh_token = refreshToken;
		response.expires_in_ms = 300_000;
	}

	return { status: 200, body: response };
};

const handleAppserviceLogin = async (
	storage: Storage,
	serverName: string,
	registrations: AppserviceRegistration[],
	req: RouterRequest,
	body: LoginRequest,
): Promise<RouterResponse> => {
	let asToken: string;
	try {
		asToken = extractAccessToken(req);
	} catch {
		throw forbidden("Missing as_token for application_service login");
	}

	const reg = findAppserviceByToken(asToken, registrations);
	if (!reg) throw forbidden("Invalid as_token");

	if (!body.identifier || body.identifier.type !== "m.id.user")
		throw invalidParam("Only m.id.user identifier is supported");

	let localpart = body.identifier.user;
	if (localpart.startsWith("@")) {
		const colonIdx = localpart.indexOf(":");
		localpart =
			colonIdx > 0 ? localpart.slice(1, colonIdx) : localpart.slice(1);
	}

	const userId = `@${localpart}:${serverName}`;

	const senderUser = `@${reg.sender_localpart}:${serverName}`;
	const inNamespace = findAppserviceForUser(userId, [reg]);
	if (userId !== senderUser && !inNamespace) {
		throw forbidden("User is not in the appservice's namespace");
	}

	let account = await storage.getUserByLocalpart(localpart);
	if (!account) {
		await storage.createUser({
			user_id: userId,
			localpart,
			server_name: serverName,
			password_hash: generateToken(),
			account_type: "user",
			is_deactivated: false,
			created_at: Date.now(),
		});
		account = await storage.getUserByLocalpart(localpart);
	}

	if (!account) throw forbidden("Failed to create user");
	if (account.is_deactivated)
		throw forbidden("This account has been deactivated");

	const { accessToken, deviceId, refreshToken } =
		await createSessionAndRespond(storage, req, account.user_id, body);

	const response: LoginResponse = {
		user_id: account.user_id,
		access_token: accessToken,
		device_id: deviceId,
		well_known: {
			"m.homeserver": { base_url: `https://${serverName}` },
		},
	};

	if (refreshToken) {
		response.refresh_token = refreshToken;
		response.expires_in_ms = 300_000;
	}

	return { status: 200, body: response };
};
