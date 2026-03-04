import { randomBytes } from "node:crypto";

export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

export function generateSessionId(): string {
	return randomBytes(16).toString("base64url");
}

export function generateDeviceId(): string {
	return randomBytes(8).toString("base64url").toUpperCase();
}

export function generateRoomId(serverName: string): string {
	return `!${randomBytes(18).toString("base64url")}:${serverName}`;
}
