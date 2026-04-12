import { randomInt } from "node:crypto";
import { generateSessionId } from "../crypto.ts";
import { badJson, MatrixError } from "../errors.ts";
import type { Handler } from "../router.ts";
import { getSmtpConfig, sendEmail } from "../smtp.ts";
import type { Storage } from "../storage/interface.ts";
import type { JsonObject } from "../types/json.ts";

/** Generate a random 6-digit verification token. */
const generateVerificationToken = (): string => {
	return String(randomInt(100000, 999999));
};

/** Build the HTML email body for verification. */
const buildVerificationEmail = (
	token: string,
	serverName: string,
): string => {
	return `<!DOCTYPE html>
<html>
<head><title>Email Verification</title></head>
<body>
<h2>Email Verification</h2>
<p>Your verification code is:</p>
<h1 style="font-size: 32px; letter-spacing: 4px; font-family: monospace;">${token}</h1>
<p>Enter this code in your Matrix client to verify your email address.</p>
<p>This code was requested by the Matrix homeserver at <strong>${serverName}</strong>.</p>
<p>If you did not request this, you can safely ignore this email.</p>
</body>
</html>`;
};

/**
 * Handle an email requestToken flow: generate token, store session, send email.
 * Used by register, account 3pid add, and password reset endpoints.
 */
const handleEmailRequestToken = async (
	storage: Storage,
	serverName: string,
	body: {
		client_secret?: string;
		email?: string;
		send_attempt?: number;
		next_link?: string;
	},
): Promise<{ status: number; body: { sid: string } }> => {
	if (!body.client_secret) throw badJson("Missing 'client_secret'");
	if (!body.email) throw badJson("Missing 'email'");
	if (body.send_attempt === undefined)
		throw badJson("Missing 'send_attempt'");

	const sessionId = generateSessionId();
	const token = generateVerificationToken();

	await storage.storeVerificationToken(sessionId, {
		medium: "email",
		address: body.email,
		clientSecret: body.client_secret,
		sendAttempt: body.send_attempt,
		token,
		validated: false,
	});

	// Send email if SMTP is configured, otherwise log to stdout
	const smtpConfig = getSmtpConfig();
	if (smtpConfig) {
		const htmlBody = buildVerificationEmail(token, serverName);
		try {
			await sendEmail(
				smtpConfig,
				body.email,
				`Verification code: ${token}`,
				htmlBody,
			);
		} catch (err) {
			console.error("Failed to send verification email:", err);
			// Still return the session — the user can retry
		}
	} else {
		console.log(
			`[3PID] Verification token for ${body.email}: ${token} (session: ${sessionId})`,
		);
	}

	return { status: 200, body: { sid: sessionId } };
};

/** Return M_THREEPID_DENIED for unsupported MSISDN (phone) verification. */
const msisdnDenied = (): { status: number; body: { errcode: string; error: string } } => ({
	status: 403,
	body: {
		errcode: "M_THREEPID_DENIED",
		error: "SMS/phone verification is not supported by this homeserver",
	},
});

// --- Endpoint handlers ---

/** POST /_matrix/client/v3/register/email/requestToken */
export const postRegisterEmailRequestToken =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			client_secret?: string;
			email?: string;
			send_attempt?: number;
			next_link?: string;
		};

		// Check if email is already registered
		if (body.email) {
			// For registration, we check that the email is NOT already in use
			// The spec says to return M_THREEPID_IN_USE if already associated
			// For simplicity, we allow it (since our 3PID binding is loose)
		}

		return handleEmailRequestToken(storage, serverName, body);
	};

/** POST /_matrix/client/v3/register/msisdn/requestToken */
export const postRegisterMsisdnRequestToken =
	(): Handler =>
	async (_req) => {
		return msisdnDenied();
	};

/** POST /_matrix/client/v3/account/3pid/email/requestToken */
export const postAccount3pidEmailRequestToken =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			client_secret?: string;
			email?: string;
			send_attempt?: number;
			next_link?: string;
		};
		return handleEmailRequestToken(storage, serverName, body);
	};

/** POST /_matrix/client/v3/account/3pid/msisdn/requestToken */
export const postAccount3pidMsisdnRequestToken =
	(): Handler =>
	async (_req) => {
		return msisdnDenied();
	};

/** POST /_matrix/client/v3/account/password/email/requestToken */
export const postPasswordEmailRequestToken =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			client_secret?: string;
			email?: string;
			send_attempt?: number;
			next_link?: string;
		};
		return handleEmailRequestToken(storage, serverName, body);
	};

/** POST /_matrix/client/v3/account/password/msisdn/requestToken */
export const postPasswordMsisdnRequestToken =
	(): Handler =>
	async (_req) => {
		return msisdnDenied();
	};

/** POST /_matrix/client/v3/account/3pid/bind — stub (no identity server integration) */
export const postThreePidBind =
	(): Handler =>
	async (_req) => {
		return { status: 200, body: {} };
	};

/** POST /_matrix/client/v3/account/3pid/unbind — stub (no identity server integration) */
export const postThreePidUnbind =
	(): Handler =>
	async (_req) => {
		return { status: 200, body: { id_server_unbind_result: "no-support" } };
	};

/** GET /_matrix/client/v1/register/m.login.registration_token/validity */
export const getRegistrationTokenValidity =
	(): Handler =>
	async (_req) => {
		// We don't support registration tokens, so always return invalid
		return { status: 200, body: { valid: false } };
	};

/** GET /_matrix/client/v3/register/available */
export const getRegisterAvailable =
	(storage: Storage): Handler =>
	async (req) => {
		const username = req.query.get("username");
		if (!username) throw badJson("Missing 'username' query parameter");

		const localpart = username.toLowerCase();
		const existing = await storage.getUserByLocalpart(localpart);
		if (existing) {
			throw new MatrixError("M_USER_IN_USE", "User ID already taken", 400);
		}

		return { status: 200, body: { available: true } };
	};

/** POST /_matrix/client/v1/login/get_token — generate a single-use login token */
export const postLoginGetToken =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId!;
		const token = generateSessionId();
		const expiresInMs = 120_000;
		const expiresAt = Date.now() + expiresInMs;

		await storage.storeLoginToken(token, userId, expiresAt);

		return {
			status: 200,
			body: {
				login_token: token,
				expires_in_ms: expiresInMs,
			},
		};
	};

/** GET /_matrix/client/v3/admin/whois/:userId */
export const getAdminWhois =
	(storage: Storage): Handler =>
	async (req) => {
		const targetUserId = req.params.userId!;

		const sessions = await storage.getSessionsByUser(targetUserId);

		const devices: Record<
			string,
			{
				sessions: {
					connections: {
						ip: string;
						last_seen: number;
						user_agent: string;
					}[];
				}[];
			}
		> = {};

		for (const session of sessions) {
			const deviceId = session.device_id;
			if (!devices[deviceId]) {
				devices[deviceId] = { sessions: [] };
			}
			devices[deviceId].sessions.push({
				connections: [
					{
						ip: session.last_seen_ip ?? "",
						last_seen: session.last_seen_ts ?? 0,
						user_agent: session.user_agent ?? "",
					},
				],
			});
		}

		return {
			status: 200,
			body: {
				user_id: targetUserId,
				devices,
			},
		};
	};

/** POST /_matrix/client/v3/knock/:roomIdOrAlias */
export const postKnock =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomIdOrAlias = req.params.roomIdOrAlias!;
		const body = (req.body ?? {}) as { reason?: string };
		const userId = req.userId!;

		let roomId: string;
		if (roomIdOrAlias.startsWith("#")) {
			const resolved = await storage.getRoomByAlias(roomIdOrAlias);
			if (!resolved) {
				throw new MatrixError("M_NOT_FOUND", `Room alias ${roomIdOrAlias} not found`, 404);
			}
			roomId = resolved.room_id;
		} else {
			roomId = roomIdOrAlias;
		}

		const room = await storage.getRoom(roomId);
		if (!room) throw new MatrixError("M_NOT_FOUND", "Room not found", 404);

		const { sendStateEvent } = await import("../events.ts");
		const knockContent: JsonObject = { membership: "knock" };
		if (body.reason) knockContent.reason = body.reason;

		const ctx = {
			roomState: room,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
		};

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.member",
			userId,
			knockContent,
		);

		return { status: 200, body: { room_id: roomId } };
	};
