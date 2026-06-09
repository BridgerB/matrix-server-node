import { canonicalJson } from "../events.ts";
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

		// MSC3967: UIA is only required when REPLACING an existing cross-signing
		// key. First-time setup (no existing master key) is allowed without UIA,
		// and re-uploading the exact same keys is idempotent (no UIA).
		//
		// Mirrors Synapse's SigningKeyUploadServlet.on_POST:
		//   1. is_cross_signing_setup = a master key already exists.
		//   2. keys_are_different = any provided key differs from what is stored
		//      (a brand-new key counts as different). If nothing differs, return
		//      200 without UIA (idempotent re-upload).
		//   3. If keys differ AND cross-signing is already set up, require UIA.
		const isCrossSigningSetup = existing.master_key !== undefined;

		const keyPairs: [
			"master_key" | "self_signing_key" | "user_signing_key",
			CrossSigningKey | undefined,
			CrossSigningKey | undefined,
		][] = [
			["master_key", body.master_key, existing.master_key],
			["self_signing_key", body.self_signing_key, existing.self_signing_key],
			["user_signing_key", body.user_signing_key, existing.user_signing_key],
		];

		let keysAreDifferent = false;
		for (const [, provided, stored] of keyPairs) {
			if (!provided) continue;
			// A key being inserted for the first time, or whose stored value
			// differs from the provided value, counts as a difference.
			if (!stored || canonicalJson(stored) !== canonicalJson(provided)) {
				keysAreDifferent = true;
				break;
			}
		}

		// Idempotent re-upload (or empty body): nothing to change, no UIA.
		if (!keysAreDifferent) {
			return { status: 200, body: {} };
		}

		// Keys differ and cross-signing is already set up: require UIA.
		if (isCrossSigningSetup) {
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

				await storage.addUIAACompleted(body.auth.session!, "m.login.password");
				await storage.deleteUIAASession(body.auth.session!);
			} else {
				throw forbidden(`Unsupported auth type: ${body.auth.type}`);
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
