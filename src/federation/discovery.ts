import { resolveSrv } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";

export interface ResolvedServer {
	readonly host: string;
	readonly port: number;
	readonly serverName: string;
}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { result: ResolvedServer; expiresAt: number }>();

const fetchJson = (url: string): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const opts: RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port || 443,
			path: parsed.pathname + parsed.search,
			method: "GET",
			headers: { Accept: "application/json" },
			timeout: 5000,
			rejectUnauthorized: false,
		};

		const req = httpsRequest(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
				} catch {
					reject(new Error("Invalid JSON"));
				}
			});
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Timeout"));
		});
		req.end();
	});

/** Split a `host:port` authority, or undefined when it carries no explicit port. */
const splitHostPort = (
	authority: string,
): { host: string; port: number } | undefined => {
	const colon = authority.lastIndexOf(":");
	if (colon <= 0 || authority.endsWith("]")) return undefined;
	const port = Number(authority.slice(colon + 1));
	if (Number.isNaN(port)) return undefined;
	return { host: authority.slice(0, colon), port };
};

/** `.well-known/matrix/server` delegation for a server, if it advertises one. */
const resolveWellKnown = async (
	serverName: string,
): Promise<ResolvedServer | undefined> => {
	try {
		const wk = await fetchJson(
			`https://${serverName}/.well-known/matrix/server`,
		);
		const delegated = (wk as Record<string, unknown> | null)?.["m.server"];
		if (typeof delegated !== "string" || !delegated) return undefined;
		const hostPort = splitHostPort(delegated);
		return hostPort
			? { ...hostPort, serverName }
			: { host: delegated, port: 8448, serverName };
	} catch {
		return undefined;
	}
};

/** Highest-priority SRV target for `<service>.<serverName>`, if any exists. */
const resolveSrvService = async (
	service: string,
	serverName: string,
): Promise<ResolvedServer | undefined> => {
	try {
		const records = await resolveSrv(`${service}.${serverName}`);
		const best = records.toSorted((a, b) => a.priority - b.priority)[0];
		return best ? { host: best.name, port: best.port, serverName } : undefined;
	} catch {
		return undefined;
	}
};

const doResolve = async (serverName: string): Promise<ResolvedServer> => {
	const explicit = splitHostPort(serverName);
	if (explicit) return { ...explicit, serverName };

	return (
		(await resolveWellKnown(serverName)) ??
		(await resolveSrvService("_matrix-fed._tcp", serverName)) ??
		(await resolveSrvService("_matrix._tcp", serverName)) ?? {
			host: serverName,
			port: 8448,
			serverName,
		}
	);
};

export const resolveServer = async (
	serverName: string,
): Promise<ResolvedServer> => {
	const cached = cache.get(serverName);
	if (cached && cached.expiresAt > Date.now()) return cached.result;

	const result = await doResolve(serverName);
	cache.set(serverName, { result, expiresAt: Date.now() + CACHE_TTL });
	return result;
};
