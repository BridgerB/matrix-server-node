import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	RegisterRequest,
	UIAAResponse,
	LoginResponse,
	AuthType,
} from "../types/index.ts";
import {
	badJson,
	userInUse,
	invalidUsername,
	weakPassword,
	forbidden,
	invalidParam,
} from "../errors.ts";
import {
	generateToken,
	generateDeviceId,
	generateSessionId,
} from "../crypto.ts";

const REGISTRATION_FLOWS: { stages: AuthType[] }[] = [
	{ stages: ["m.login.dummy"] },
];

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[a-z0-9._=\-/]+$/;

export function postRegister(storage: Storage, serverName: string): Handler {
	return async (req) => {
		const body = req.body as RegisterRequest;

		// No auth data -> return UIAA challenge
		if (!body.auth) {
			const sessionId = generateSessionId();
			await storage.createUIAASession(sessionId);
			const uiaa: UIAAResponse = {
				flows: REGISTRATION_FLOWS,
				params: {},
				session: sessionId,
			};
			return { status: 401, body: uiaa };
		}

		const sessionId = body.auth.session;
		if (!sessionId) throw badJson("Missing auth session");

		const uiaaSession = await storage.getUIAASession(sessionId);
		if (!uiaaSession) throw forbidden("Unknown session");

		// Process auth stage
		if (body.auth.type === "m.login.dummy") {
			await storage.addUIAACompleted(sessionId, "m.login.dummy");
		} else {
			throw invalidParam(`Unsupported auth type: ${body.auth.type}`);
		}

		// Check if all stages complete
		const updated = await storage.getUIAASession(sessionId);
		const allCompleted = REGISTRATION_FLOWS.some((flow) =>
			flow.stages.every((stage) => updated?.completed.includes(stage)),
		);

		if (!allCompleted) {
			const uiaa: UIAAResponse = {
				flows: REGISTRATION_FLOWS,
				params: {},
				session: sessionId,
				completed: updated?.completed as AuthType[] | undefined,
			};
			return { status: 401, body: uiaa };
		}

		// UIAA complete - register the user
		if (!body.username) throw badJson("Missing 'username' field");
		const localpart = body.username.toLowerCase();
		if (!USERNAME_RE.test(localpart)) {
			throw invalidUsername(
				"Username can only contain lowercase letters, digits, and ._=-/",
			);
		}

		const existing = await storage.getUserByLocalpart(localpart);
		if (existing) throw userInUse();

		if (!body.password) throw badJson("Missing 'password' field");
		if (body.password.length < MIN_PASSWORD_LENGTH) {
			throw weakPassword(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			);
		}

		const userId = `@${localpart}:${serverName}`;
		const now = Date.now();

		await storage.createUser({
			user_id: userId,
			localpart,
			server_name: serverName,
			password_hash: body.password, // TODO: hash with argon2
			account_type: "user",
			is_deactivated: false,
			created_at: now,
		});

		await storage.deleteUIAASession(sessionId);

		if (body.inhibit_login) {
			return { status: 200, body: { user_id: userId } };
		}

		const deviceId = body.device_id ?? generateDeviceId();
		const accessToken = generateToken();
		const refreshToken = body.refresh_token ? generateToken() : undefined;

		await storage.createSession({
			device_id: deviceId,
			user_id: userId,
			access_token: accessToken,
			access_token_hash: "",
			refresh_token: refreshToken,
			display_name: body.initial_device_display_name,
			last_seen_ip: req.raw.socket.remoteAddress ?? "unknown",
			last_seen_ts: now,
			user_agent: (req.headers["user-agent"] as string) ?? "",
		});

		const response: LoginResponse = {
			user_id: userId,
			access_token: accessToken,
			device_id: deviceId,
		};

		if (refreshToken) {
			response.refresh_token = refreshToken;
			response.expires_in_ms = 300_000;
		}

		return { status: 200, body: response };
	};
}
