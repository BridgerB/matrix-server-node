import { randomBytes } from "node:crypto";

export const generateToken = (): string =>
	randomBytes(32).toString("base64url");

export const generateSessionId = (): string =>
	randomBytes(16).toString("base64url");

export const generateDeviceId = (): string =>
	randomBytes(8).toString("base64url").toUpperCase();

export const generateRoomId = (serverName: string): string =>
	`!${randomBytes(18).toString("base64url")}:${serverName}`;
