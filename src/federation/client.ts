import { request as httpsRequest, type RequestOptions } from "node:https";
import type { SigningKey } from "../signing.ts";
import { signJson } from "../signing.ts";
import type { ServerName } from "../types/index.ts";
import { resolveServer } from "./discovery.ts";

export class FederationClient {
	serverName: ServerName;
	signingKey: SigningKey;

	constructor(serverName: ServerName, signingKey: SigningKey) {
		this.serverName = serverName;
		this.signingKey = signingKey;
	}

	async request(
		destination: ServerName,
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; body: unknown }> {
		const resolved = await resolveServer(destination);

		// Build the signed authorization header
		const authHeader = this.buildAuthHeader(destination, method, path, body);

		const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

		const opts: RequestOptions = {
			hostname: resolved.host,
			port: resolved.port,
			path,
			method: method.toUpperCase(),
			headers: {
				Authorization: authHeader,
				Host: destination,
				"Content-Type": "application/json",
				...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
			},
			timeout: 30000,
			rejectUnauthorized: false, // Federation often uses self-signed certs in dev
		};

		return new Promise((resolve, reject) => {
			const req = httpsRequest(opts, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let parsed: unknown;
					try {
						parsed = JSON.parse(raw);
					} catch {
						parsed = raw;
					}
					resolve({ status: res.statusCode ?? 500, body: parsed });
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
	}

	private buildAuthHeader(
		destination: ServerName,
		method: string,
		uri: string,
		content?: unknown,
	): string {
		const requestObj: Record<string, unknown> = {
			method: method.toUpperCase(),
			uri,
			origin: this.serverName,
			destination,
		};
		if (content !== undefined) {
			requestObj.content = content;
		}

		signJson(requestObj, this.serverName, this.signingKey);

		const signatures = requestObj.signatures as Record<
			string,
			Record<string, string>
		>;
		const sig = signatures[this.serverName]?.[this.signingKey.keyId] as string;

		return `X-Matrix origin="${this.serverName}",destination="${destination}",key="${this.signingKey.keyId}",sig="${sig}"`;
	}
}
