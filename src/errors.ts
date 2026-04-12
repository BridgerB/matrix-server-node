import type { MatrixErrorCode } from "./types/index.ts";

export class MatrixError extends Error {
	readonly errcode: MatrixErrorCode;
	readonly error: string;
	readonly statusCode: number;
	readonly extra?: Record<string, unknown>;

	constructor(
		errcode: MatrixErrorCode,
		error: string,
		statusCode: number,
		extra?: Record<string, unknown>,
	) {
		super(error);
		this.errcode = errcode;
		this.error = error;
		this.statusCode = statusCode;
		this.extra = extra;
	}

	toJSON(): Record<string, unknown> {
		return { errcode: this.errcode, error: this.error, ...this.extra };
	}
}

export const forbidden = (msg = "Forbidden") =>
	new MatrixError("M_FORBIDDEN", msg, 403);

export const unknownToken = (msg = "Unknown token", softLogout = false) =>
	new MatrixError("M_UNKNOWN_TOKEN", msg, 401, {
		soft_logout: softLogout,
	});

export const missingToken = (msg = "Missing access token") =>
	new MatrixError("M_MISSING_TOKEN", msg, 401);

export const badJson = (msg = "Bad JSON") =>
	new MatrixError("M_BAD_JSON", msg, 400);

export const notJson = (msg = "Not JSON") =>
	new MatrixError("M_NOT_JSON", msg, 400);

export const notFound = (msg = "Not found") =>
	new MatrixError("M_NOT_FOUND", msg, 404);

export const unrecognized = (msg = "Unrecognized request") =>
	new MatrixError("M_UNRECOGNIZED", msg, 404);

export const userInUse = (msg = "User ID already taken") =>
	new MatrixError("M_USER_IN_USE", msg, 400);

export const invalidUsername = (msg = "Invalid username") =>
	new MatrixError("M_INVALID_USERNAME", msg, 400);

export const weakPassword = (msg = "Password too weak") =>
	new MatrixError("M_WEAK_PASSWORD", msg, 400);

export const unknown = (msg = "Internal server error") =>
	new MatrixError("M_UNKNOWN", msg, 500);

export const missingParam = (msg: string) =>
	new MatrixError("M_MISSING_PARAM", msg, 400);

export const invalidParam = (msg: string) =>
	new MatrixError("M_INVALID_PARAM", msg, 400);

export const roomNotFound = (msg = "Room not found") =>
	new MatrixError("M_NOT_FOUND", msg, 404);

export const notJoined = (msg = "You are not joined to this room") =>
	new MatrixError("M_FORBIDDEN", msg, 403);

export const serverNotTrusted = (msg = "Server not trusted") =>
	new MatrixError("M_SERVER_NOT_TRUSTED", msg, 403);

export const unableToAuthoriseJoin = (msg = "Unable to authorise join") =>
	new MatrixError("M_UNABLE_TO_AUTHORISE_JOIN", msg, 403);

export const incompatibleRoomVersion = (msg = "Incompatible room version") =>
	new MatrixError("M_INCOMPATIBLE_ROOM_VERSION", msg, 400);

export const userLocked = (msg = "User account has been locked") =>
	new MatrixError("M_USER_LOCKED", msg, 403);

export const userDeactivated = (msg = "User account has been deactivated") =>
	new MatrixError("M_USER_DEACTIVATED", msg, 403);
