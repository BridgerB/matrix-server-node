import { randomBytes } from "node:crypto";
import { generateSessionId } from "../crypto.ts";
import {
	badJson,
	forbidden,
	invalidParam,
	invalidUsername,
	userInUse,
	weakPassword,
} from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	AuthType,
	LoginResponse,
	RegisterRequest,
	UIAAResponse,
} from "../types/index.ts";
import { createSessionAndRespond } from "./auth-shared.ts";

const REGISTRATION_FLOWS: { stages: AuthType[] }[] = [
	{ stages: ["m.login.dummy"] },
];

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[a-z0-9._=\-/]+$/;

export const postRegister =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const kind = req.query.get("kind") ?? "user";

		if (kind === "guest") {
			return registerGuest(storage, serverName, req);
		}

		const body = req.body as RegisterRequest;

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

		if (body.auth.type === "m.login.dummy") {
			await storage.addUIAACompleted(sessionId, "m.login.dummy");
		} else {
			throw invalidParam(`Unsupported auth type: ${body.auth.type}`);
		}

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

		if (!body.username) throw badJson("Missing 'username' field");
		const localpart = body.username.toLowerCase();
		if (!USERNAME_RE.test(localpart))
			throw invalidUsername(
				"Username can only contain lowercase letters, digits, and ._=-/",
			);

		const existing = await storage.getUserByLocalpart(localpart);
		if (existing) throw userInUse();

		if (!body.password) throw badJson("Missing 'password' field");
		if (body.password.length < MIN_PASSWORD_LENGTH)
			throw weakPassword(
				`Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
			);

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

		const { accessToken, deviceId, refreshToken } =
			await createSessionAndRespond(storage, req, userId, body);

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

async function registerGuest(
	storage: Storage,
	serverName: string,
	req: import("../router.ts").RouterRequest,
): Promise<import("../router.ts").RouterResponse> {
	const guestId = randomBytes(12).toString("base64url");
	const localpart = `_guest_${guestId}`;
	const userId = `@${localpart}:${serverName}`;
	const now = Date.now();

	await storage.createUser({
		user_id: userId,
		localpart,
		server_name: serverName,
		password_hash: "",
		account_type: "guest",
		is_deactivated: false,
		created_at: now,
	});

	const body = (req.body ?? {}) as {
		device_id?: string;
		initial_device_display_name?: string;
	};

	const { accessToken, deviceId } = await createSessionAndRespond(
		storage,
		req,
		userId,
		body,
	);

	const response: LoginResponse = {
		user_id: userId,
		access_token: accessToken,
		device_id: deviceId,
	};

	return { status: 200, body: response };
}
