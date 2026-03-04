import { badJson } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export const getThreePids =
	(storage: Storage): Handler =>
	async (req) => {
		const threepids = await storage.getThreePids(req.userId as string);
		return { status: 200, body: { threepids } };
	};

export const postAddThreePid =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as { medium?: string; address?: string };
		if (!body.medium || !body.address)
			throw badJson("Missing medium or address");

		await storage.addThreePid(req.userId as string, body.medium, body.address);
		return { status: 200, body: {} };
	};

export const postDeleteThreePid =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as { medium?: string; address?: string };
		if (!body.medium || !body.address)
			throw badJson("Missing medium or address");

		await storage.deleteThreePid(
			req.userId as string,
			body.medium,
			body.address,
		);
		return { status: 200, body: { id_server_unbind_result: "no-support" } };
	};
