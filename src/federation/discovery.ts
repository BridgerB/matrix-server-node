import { request as httpsRequest, type RequestOptions } from "node:https";
import { resolveSrv } from "node:dns/promises";

export interface ResolvedServer {
  host: string;
  port: number;
  serverName: string;
}

const cache = new Map<string, { result: ResolvedServer; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function resolveServer(serverName: string): Promise<ResolvedServer> {
  const cached = cache.get(serverName);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await doResolve(serverName);
  cache.set(serverName, { result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

async function doResolve(serverName: string): Promise<ResolvedServer> {
  // If server name has explicit port, use it directly
  const colonIdx = serverName.lastIndexOf(":");
  if (colonIdx > 0 && !serverName.endsWith("]")) {
    const host = serverName.slice(0, colonIdx);
    const port = parseInt(serverName.slice(colonIdx + 1), 10);
    if (!isNaN(port)) {
      return { host, port, serverName };
    }
  }

  // Try .well-known
  try {
    const wk = await fetchJson(`https://${serverName}/.well-known/matrix/server`);
    if (wk && typeof wk === "object" && "m.server" in wk) {
      const delegated = (wk as Record<string, unknown>)["m.server"] as string;
      if (delegated) {
        const dColon = delegated.lastIndexOf(":");
        if (dColon > 0) {
          return { host: delegated.slice(0, dColon), port: parseInt(delegated.slice(dColon + 1), 10), serverName };
        }
        return { host: delegated, port: 8448, serverName };
      }
    }
  } catch {
    // .well-known not available, continue
  }

  // Try DNS SRV _matrix-fed._tcp
  try {
    const records = await resolveSrv(`_matrix-fed._tcp.${serverName}`);
    if (records.length > 0) {
      const best = records.sort((a, b) => a.priority - b.priority)[0]!;
      return { host: best.name, port: best.port, serverName };
    }
  } catch {
    // No SRV record
  }

  // Try legacy DNS SRV _matrix._tcp
  try {
    const records = await resolveSrv(`_matrix._tcp.${serverName}`);
    if (records.length > 0) {
      const best = records.sort((a, b) => a.priority - b.priority)[0]!;
      return { host: best.name, port: best.port, serverName };
    }
  } catch {
    // No SRV record
  }

  // Fallback to serverName:8448
  return { host: serverName, port: 8448, serverName };
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "Accept": "application/json" },
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
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}
