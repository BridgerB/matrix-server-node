import { generateToken } from "../crypto.ts";
import { forbidden } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export const postOpenIdToken =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as string;
		if (req.userId !== targetUserId)
			throw forbidden("Can only request tokens for yourself");

		const token = generateToken();
		const expiresIn = 3600;
		const expiresAt = Date.now() + expiresIn * 1000;

		await storage.storeOpenIdToken(token, req.userId as string, expiresAt);

		return {
			status: 200,
			body: {
				access_token: token,
				token_type: "Bearer",
				matrix_server_name: serverName,
				expires_in: expiresIn,
			},
		};
	};
