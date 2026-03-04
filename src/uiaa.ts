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

	const sessionId = auth.session as string | undefined;
	if (!sessionId) throw badJson("Missing auth session");

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
