import { generateSessionId } from "./crypto.ts";
import { badJson, forbidden } from "./errors.ts";
import type { Storage } from "./storage/interface.ts";
import type { UIAAResponse } from "./types/auth.ts";
import type { AuthType } from "./types/index.ts";

export const UIAA_FLOWS: { stages: AuthType[] }[] = [
	{ stages: ["m.login.dummy"] },
];

export const requireUIAA = async (
	storage: Storage,
	body: Record<string, unknown>,
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
): Promise<{ status: number; body: unknown } | null> => {
	try {
		await requireUIAA(storage, body);
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
