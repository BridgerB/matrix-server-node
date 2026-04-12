import { MatrixError, badJson, missingParam, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { KeyBackupData } from "../types/e2ee.ts";
import type { RoomId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

const validateKeyBackupData = (data: unknown): data is KeyBackupData => {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.first_message_index === "number" &&
		typeof d.forwarded_count === "number" &&
		typeof d.is_verified === "boolean" &&
		d.session_data !== null &&
		typeof d.session_data === "object"
	);
};

// POST /room_keys/version — create new backup version
export const postKeyBackupVersion =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as Record<string, unknown>;

		if (!body.algorithm || typeof body.algorithm !== "string")
			throw missingParam("algorithm");
		if (!body.auth_data || typeof body.auth_data !== "object")
			throw missingParam("auth_data");

		const version = await storage.createKeyBackupVersion(
			userId,
			body.algorithm,
			body.auth_data as JsonObject,
		);

		return { status: 200, body: { version } };
	};

// GET /room_keys/version — get latest backup version
export const getKeyBackupVersion =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = req.params.version as string | undefined;

		const backup = await storage.getKeyBackupVersion(userId, version);
		if (!backup) throw notFound("No backup found");

		return { status: 200, body: backup };
	};

// PUT /room_keys/version/:version — update backup version
export const putKeyBackupVersion =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = req.params.version as string;
		const body = (req.body ?? {}) as {
			algorithm: string;
			auth_data: JsonObject;
			version?: string;
		};

		if (body.version && body.version !== version) {
			throw new MatrixError(
				"M_INVALID_PARAM",
				"Version in body does not match path",
				400,
			);
		}

		const existing = await storage.getKeyBackupVersion(userId, version);
		if (!existing) throw notFound("Backup version not found");

		if (body.algorithm !== existing.algorithm) {
			throw new MatrixError(
				"M_INVALID_PARAM",
				"Algorithm does not match existing backup",
				400,
			);
		}

		await storage.updateKeyBackupVersion(userId, version, body.auth_data);
		return { status: 200, body: {} };
	};

// DELETE /room_keys/version/:version — delete backup version
export const deleteKeyBackupVersion =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = req.params.version as string;

		const deleted = await storage.deleteKeyBackupVersion(userId, version);
		if (!deleted) throw notFound("Backup version not found");

		return { status: 200, body: {} };
	};

// Helper to get and validate version param
const getVersionParam = (req: { query: URLSearchParams }): string => {
	const version = req.query.get("version");
	if (!version) {
		throw new MatrixError(
			"M_MISSING_PARAM",
			"Missing required query parameter: version",
			400,
		);
	}
	return version;
};

// Helper to throw wrong version error
const throwWrongVersion = async (
	storage: Storage,
	userId: UserId,
): Promise<never> => {
	const latest = await storage.getKeyBackupVersion(userId);
	throw new MatrixError(
		"M_WRONG_ROOM_KEYS_VERSION",
		"Wrong backup version",
		403,
		{ current_version: latest?.version },
	);
};

// PUT /room_keys/keys/:roomId/:sessionId — store single session key
export const putKeyBackupSession =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const sessionId = req.params.sessionId as string;
		const version = getVersionParam(req);
		if (!validateKeyBackupData(req.body))
			throw badJson(
				"Invalid key backup data: requires first_message_index, forwarded_count, is_verified, session_data",
			);
		const body = req.body as KeyBackupData;

		const result = await storage.putKeyBackupKeys(
			userId,
			version,
			roomId,
			sessionId,
			body,
		);
		if (!result) return throwWrongVersion(storage, userId);

		return { status: 200, body: result };
	};

// GET /room_keys/keys/:roomId/:sessionId — get single session key
export const getKeyBackupSession =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const sessionId = req.params.sessionId as string;
		const version = getVersionParam(req);

		const backup = await storage.getKeyBackupVersion(userId, version);
		if (!backup) throw notFound("Backup version not found");

		const data = await storage.getKeyBackupKeys(
			userId,
			version,
			roomId,
			sessionId,
		);
		if (!data) throw notFound("Key not found");

		return { status: 200, body: data };
	};

// DELETE /room_keys/keys/:roomId/:sessionId — delete single session key
export const deleteKeyBackupSession =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const sessionId = req.params.sessionId as string;
		const version = getVersionParam(req);

		const result = await storage.deleteKeyBackupKeys(
			userId,
			version,
			roomId,
			sessionId,
		);
		if (!result) throw notFound("Backup version not found");

		return { status: 200, body: result };
	};

// PUT /room_keys/keys/:roomId — store room keys
export const putKeyBackupRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const version = getVersionParam(req);
		const body = req.body as { sessions: Record<string, KeyBackupData> };

		const result = await storage.putKeyBackupKeys(
			userId,
			version,
			roomId,
			undefined,
			body,
		);
		if (!result) return throwWrongVersion(storage, userId);

		return { status: 200, body: result };
	};

// GET /room_keys/keys/:roomId — get room keys
export const getKeyBackupRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const version = getVersionParam(req);

		const backup = await storage.getKeyBackupVersion(userId, version);
		if (!backup) throw notFound("Backup version not found");

		const data = await storage.getKeyBackupKeys(userId, version, roomId);
		return { status: 200, body: data ?? { sessions: {} } };
	};

// DELETE /room_keys/keys/:roomId — delete room keys
export const deleteKeyBackupRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const roomId = req.params.roomId as RoomId;
		const version = getVersionParam(req);

		const result = await storage.deleteKeyBackupKeys(
			userId,
			version,
			roomId,
		);
		if (!result) throw notFound("Backup version not found");

		return { status: 200, body: result };
	};

// PUT /room_keys/keys — store all keys
export const putKeyBackupAll =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = getVersionParam(req);
		const body = req.body as {
			rooms: Record<
				RoomId,
				{ sessions: Record<string, KeyBackupData> }
			>;
		};

		const result = await storage.putKeyBackupKeys(
			userId,
			version,
			undefined,
			undefined,
			body,
		);
		if (!result) return throwWrongVersion(storage, userId);

		return { status: 200, body: result };
	};

// GET /room_keys/keys — get all keys
export const getKeyBackupAll =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = getVersionParam(req);

		const backup = await storage.getKeyBackupVersion(userId, version);
		if (!backup) throw notFound("Backup version not found");

		const data = await storage.getKeyBackupKeys(userId, version);
		return { status: 200, body: data ?? { rooms: {} } };
	};

// DELETE /room_keys/keys — delete all keys
export const deleteKeyBackupAll =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const version = getVersionParam(req);

		const result = await storage.deleteKeyBackupKeys(userId, version);
		if (!result) throw notFound("Backup version not found");

		return { status: 200, body: result };
	};
