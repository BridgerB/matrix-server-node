import {
	Agent,
	request as httpsRequest,
	type RequestOptions,
} from "node:https";
import type { SigningKey } from "../signing.ts";
import { signJson } from "../signing.ts";
import type { ServerName } from "../types/index.ts";
import { resolveServer } from "./discovery.ts";

/**
 * Shared keep-alive HTTPS agent for all outbound federation requests. Without
 * connection reuse every federation round-trip (make_join, send_join, /send,
 * key fetches, backfill, …) pays a fresh TLS handshake, which is slow and, under
 * the concurrent load of a full test run, a significant source of latency. A
 * pooled keep-alive agent reuses connections per destination.
 */
const federationAgent = new Agent({
	keepAlive: true,
	maxSockets: 64,
	rejectUnauthorized: false, // Federation often uses self-signed certs in dev
});

export interface FederationResponse {
	readonly status: number;
	readonly body: unknown;
}

export interface FederationClient {
	readonly serverName: ServerName;
	readonly signingKey: SigningKey;
	request(
		destination: ServerName,
		method: string,
		path: string,
		body?: unknown,
	): Promise<FederationResponse>;
}

/**
 * The `X-Matrix` Authorization header value for an outbound request, derived by
 * signing the canonical request object `{ method, uri, origin, destination,
 * content? }` with our signing key.
 */
const authHeader = (
	origin: ServerName,
	signingKey: SigningKey,
	destination: ServerName,
	method: string,
	uri: string,
	content?: unknown,
): string => {
	const signed = signJson(
		{
			method: method.toUpperCase(),
			uri,
			origin,
			destination,
			...(content !== undefined ? { content } : {}),
		},
		origin,
		signingKey,
	);
	const signatures = signed.signatures as Record<
		string,
		Record<string, string>
	>;
	const sig = signatures[origin]?.[signingKey.keyId] ?? "";
	return `X-Matrix origin="${origin}",destination="${destination}",key="${signingKey.keyId}",sig="${sig}"`;
};

/** Perform the request and resolve to its status + parsed (or raw) body. */
const send = (
	opts: RequestOptions,
	bodyStr: string | undefined,
): Promise<FederationResponse> =>
	new Promise((resolve, reject) => {
		const req = httpsRequest(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				let body: unknown;
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
				resolve({ status: res.statusCode ?? 500, body });
			});
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Federation request timeout"));
		});
		if (bodyStr) req.write(bodyStr);
		req.end();
	});

export const createFederationClient = (
	serverName: ServerName,
	signingKey: SigningKey,
): FederationClient => ({
	serverName,
	signingKey,
	async request(destination, method, path, body) {
		const resolved = await resolveServer(destination);
		const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
		const opts: RequestOptions = {
			hostname: resolved.host,
			port: resolved.port,
			path,
			method: method.toUpperCase(),
			headers: {
				Authorization: authHeader(
					serverName,
					signingKey,
					destination,
					method,
					path,
					body,
				),
				Host: destination,
				"Content-Type": "application/json",
				...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
			},
			timeout: 10000,
			rejectUnauthorized: false, // Federation often uses self-signed certs in dev
			agent: federationAgent,
		};
		return send(opts, bodyStr);
	},
});
