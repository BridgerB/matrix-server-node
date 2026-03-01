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

export function forbidden(msg = "Forbidden") {
  return new MatrixError("M_FORBIDDEN", msg, 403);
}

export function unknownToken(msg = "Unknown token", softLogout = false) {
  return new MatrixError("M_UNKNOWN_TOKEN", msg, 401, { soft_logout: softLogout });
}

export function missingToken(msg = "Missing access token") {
  return new MatrixError("M_MISSING_TOKEN", msg, 401);
}

export function badJson(msg = "Bad JSON") {
  return new MatrixError("M_BAD_JSON", msg, 400);
}

export function notJson(msg = "Not JSON") {
  return new MatrixError("M_NOT_JSON", msg, 400);
}

export function notFound(msg = "Not found") {
  return new MatrixError("M_NOT_FOUND", msg, 404);
}

export function unrecognized(msg = "Unrecognized request") {
  return new MatrixError("M_UNRECOGNIZED", msg, 404);
}

export function userInUse(msg = "User ID already taken") {
  return new MatrixError("M_USER_IN_USE", msg, 400);
}

export function invalidUsername(msg = "Invalid username") {
  return new MatrixError("M_INVALID_USERNAME", msg, 400);
}

export function weakPassword(msg = "Password too weak") {
  return new MatrixError("M_WEAK_PASSWORD", msg, 400);
}

export function unknown(msg = "Internal server error") {
  return new MatrixError("M_UNKNOWN", msg, 500);
}

export function missingParam(msg: string) {
  return new MatrixError("M_MISSING_PARAM", msg, 400);
}

export function invalidParam(msg: string) {
  return new MatrixError("M_INVALID_PARAM", msg, 400);
}
