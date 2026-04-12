import { generateSessionId } from "./crypto.ts";
import { verifyPassword } from "./crypto-utils.ts";
import { badJson, forbidden } from "./errors.ts";
import type { Storage } from "./storage/interface.ts";
import type { UIAAResponse } from "./types/auth.ts";
import type { AuthType } from "./types/index.ts";

export const UIAA_FLOWS: { stages: AuthType[] }[] = [
	{ stages: ["m.login.password" as AuthType] },
	{ stages: ["m.login.dummy"] },
];

export const requireUIAA = async (
	storage: Storage,
	body: Record<string, unknown>,
	userId?: string,
): Promise<boolean> => {
	const auth = body.auth as Record<string, unknown> | undefined;

	if (!auth) {
		const sessionId = generateSessionId();
		await storage.createUIAASession(sessionId);
		const uiaa: UIAAResponse = {
			flows: UIAA_FLOWS,
			params: {},
			session: sessionId,
		};
		throw Object.assign(new Error("UIAA"), { uiaaResponse: uiaa });
	}

	let sessionId = auth.session as string | undefined;
	if (!sessionId) {
		// Allow single-step auth: create a session on the fly
		sessionId = generateSessionId();
		await storage.createUIAASession(sessionId);
	}

	const uiaaSession = await storage.getUIAASession(sessionId);
	if (!uiaaSession) throw forbidden("Unknown session");

	if (auth.type === "m.login.dummy") {
		await storage.addUIAACompleted(sessionId, "m.login.dummy");
	} else if (auth.type === "m.login.password") {
		// Validate password for m.login.password UIAA
		const identifier = auth.identifier as
			| Record<string, unknown>
			| undefined;
		const password = auth.password as string | undefined;

		const failWithUIAA = (error: string): never => {
			const uiaa: UIAAResponse = {
				flows: UIAA_FLOWS,
				params: {},
				session: sessionId!,
				errcode: "M_FORBIDDEN" as string,
				error,
			};
			throw Object.assign(new Error("UIAA"), { uiaaResponse: uiaa });
		};

		if (!password) return failWithUIAA("Missing password");

		let localpart: string | undefined;
		if (identifier && identifier.type === "m.id.user") {
			let user = identifier.user as string;
			if (user.startsWith("@")) {
				const colonIdx = user.indexOf(":");
				user = colonIdx > 0 ? user.slice(1, colonIdx) : user.slice(1);
			}
			localpart = user;
		} else if (userId) {
			// Fall back to the authenticated user
			const colonIdx = userId.indexOf(":");
			localpart =
				colonIdx > 0 ? userId.slice(1, colonIdx) : userId.slice(1);
		}

		if (!localpart) return failWithUIAA("Cannot determine user for authentication");

		const account = await storage.getUserByLocalpart(localpart);
		if (!account) return failWithUIAA("Invalid username or password");

		const valid = await verifyPassword(password, account.password_hash);
		if (!valid) return failWithUIAA("Invalid username or password");

		await storage.addUIAACompleted(
			sessionId,
			"m.login.password" as AuthType,
		);
	} else {
		throw badJson(`Unsupported auth type: ${auth.type}`);
	}

	const updated = await storage.getUIAASession(sessionId);
	const allCompleted = UIAA_FLOWS.some((flow) =>
		flow.stages.every((stage) => updated?.completed.includes(stage)),
	);

	if (!allCompleted) {
		const uiaa: UIAAResponse = {
			flows: UIAA_FLOWS,
			params: {},
			session: sessionId,
			completed: updated?.completed as AuthType[],
		};
		throw Object.assign(new Error("UIAA"), { uiaaResponse: uiaa });
	}

	await storage.deleteUIAASession(sessionId);
	return true;
};

export const withUIAA = async (
	storage: Storage,
	body: Record<string, unknown>,
	userId?: string,
): Promise<{ status: number; body: unknown } | null> => {
	try {
		await requireUIAA(storage, body, userId);
		return null;
	} catch (err: unknown) {
		if (err && typeof err === "object" && "uiaaResponse" in err) {
			return {
				status: 401,
				body: (err as { uiaaResponse: unknown }).uiaaResponse,
			};
		}
		throw err;
	}
};
