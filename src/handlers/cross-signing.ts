import { generateSessionId } from "../crypto.ts";
import { badJson, forbidden } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { CrossSigningKey } from "../types/e2ee.ts";
import type { UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const postDeviceSigningUpload =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as {
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
			auth?: {
				type?: string;
				session?: string;
				password?: string;
				identifier?: { type: string; user?: string };
			};
		};

		const existing = await storage.getCrossSigningKeys(userId);

		// UIAA is required if master key already exists and is changing
		if (existing.master_key && body.master_key) {
			const existingKeyId = Object.keys(existing.master_key.keys)[0];
			const newKeyId = Object.keys(body.master_key.keys)[0];
			const existingKeyVal =
				existingKeyId !== undefined
					? existing.master_key.keys[existingKeyId]
					: undefined;
			const newKeyVal =
				newKeyId !== undefined ? body.master_key.keys[newKeyId] : undefined;
			if (existingKeyVal !== newKeyVal) {
				if (!body.auth || !body.auth.type) {
					const sessionId = generateSessionId();
					await storage.createUIAASession(sessionId);
					return {
						status: 401,
						body: {
							flows: [{ stages: ["m.login.password"] }],
							params: {},
							session: sessionId,
						},
					};
				}

				// Validate UIAA auth
				if (body.auth.type === "m.login.password") {
					const session = body.auth.session
						? await storage.getUIAASession(body.auth.session)
						: undefined;
					if (!session) throw forbidden("Unknown session");

					const account = await storage.getUserById(userId);
					if (!account) throw forbidden("User not found");

					if (body.auth.password !== account.password_hash)
						throw forbidden("Invalid password");

					await storage.addUIAACompleted(
						body.auth.session!,
						"m.login.password",
					);
					await storage.deleteUIAASession(body.auth.session!);
				} else {
					throw forbidden(`Unsupported auth type: ${body.auth.type}`);
				}
			}
		}

		// Validate key user_ids match
		for (const [name, key] of Object.entries({
			master_key: body.master_key,
			self_signing_key: body.self_signing_key,
			user_signing_key: body.user_signing_key,
		})) {
			if (key && key.user_id !== userId) {
				throw badJson(`${name} user_id does not match authenticated user`);
			}
		}

		// Check for device ID collision with public keys
		const allDevices = await storage.getAllDevices(userId);
		const deviceIds = new Set(allDevices.map((d) => d.device_id));
		for (const key of [
			body.master_key,
			body.self_signing_key,
			body.user_signing_key,
		]) {
			if (!key) continue;
			for (const keyId of Object.keys(key.keys)) {
				const parts = keyId.split(":");
				const tag = parts[1];
				if (tag && deviceIds.has(tag)) {
					throw forbidden(
						`Key ID ${keyId} collides with an existing device ID`,
					);
				}
			}
		}

		const keysToStore: {
			master_key?: CrossSigningKey;
			self_signing_key?: CrossSigningKey;
			user_signing_key?: CrossSigningKey;
		} = {};
		if (body.master_key) keysToStore.master_key = body.master_key;
		if (body.self_signing_key)
			keysToStore.self_signing_key = body.self_signing_key;
		if (body.user_signing_key)
			keysToStore.user_signing_key = body.user_signing_key;

		if (Object.keys(keysToStore).length > 0) {
			await storage.setCrossSigningKeys(userId, keysToStore);
		}

		return { status: 200, body: {} };
	};

export const postSignaturesUpload =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as Record<string, Record<string, JsonObject>>;

		const failures = await storage.storeCrossSigningSignatures(userId, body);

		return { status: 200, body: { failures } };
	};
