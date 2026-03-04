import type { IncomingMessage, ServerResponse } from "node:http";
import { MatrixError } from "./errors.ts";
import type {
	AccessToken,
	DeviceId,
	ServerName,
	UserId,
} from "./types/index.ts";

export interface RouterRequest {
	raw: IncomingMessage;
	method: string;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
	body: unknown;
	rawBody?: Buffer;
	userId?: UserId;
	deviceId?: DeviceId;
	accessToken?: AccessToken;
	origin?: ServerName;
}

export interface RouterResponse {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

export type Handler = (
	req: RouterRequest,
) => RouterResponse | Promise<RouterResponse>;
export type Middleware = (
	req: RouterRequest,
	next: Handler,
) => RouterResponse | Promise<RouterResponse>;

interface Route {
	method: string;
	pattern: string;
	segments: string[];
	handler: Handler;
	middleware: Middleware[];
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});

const respondJson = (
	res: ServerResponse,
	status: number,
	body: unknown,
	headers?: Record<string, string>,
) => {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
		...headers,
	});
	res.end(json);
};

const matchRoute = (
	routeSegments: string[],
	pathSegments: string[],
): Record<string, string> | null => {
	if (routeSegments.length !== pathSegments.length) return null;
	const params: Record<string, string> = {};
	const matched = routeSegments.every((routeSeg, i) => {
		const pathSeg = pathSegments[i] as string;
		if (routeSeg.startsWith(":")) {
			params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
			return true;
		}
		return routeSeg === pathSeg;
	});
	return matched ? params : null;
};

export class Router {
	private routes: Route[] = [];
	private globalMiddleware: Middleware[] = [];

	use(mw: Middleware): void {
		this.globalMiddleware.push(mw);
	}

	add(
		method: string,
		pattern: string,
		handler: Handler,
		...middleware: Middleware[]
	): void {
		this.routes.push({
			method: method.toUpperCase(),
			pattern,
			segments: pattern.split("/").filter(Boolean),
			handler,
			middleware,
		});
	}

	get(pattern: string, handler: Handler, ...middleware: Middleware[]): void {
		this.add("GET", pattern, handler, ...middleware);
	}

	post(pattern: string, handler: Handler, ...middleware: Middleware[]): void {
		this.add("POST", pattern, handler, ...middleware);
	}

	put(pattern: string, handler: Handler, ...middleware: Middleware[]): void {
		this.add("PUT", pattern, handler, ...middleware);
	}

	delete(pattern: string, handler: Handler, ...middleware: Middleware[]): void {
		this.add("DELETE", pattern, handler, ...middleware);
	}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		const method = (req.method ?? "GET").toUpperCase();
		const pathSegments = url.pathname.split("/").filter(Boolean);

		let matchedRoute: Route | undefined;
		let params: Record<string, string> = {};

		for (const route of this.routes) {
			if (route.method !== method) continue;
			const m = matchRoute(route.segments, pathSegments);
			if (m) {
				matchedRoute = route;
				params = m;
				break;
			}
		}

		let body: unknown;
		let rawBody: Buffer | undefined;
		const isMedia = url.pathname.startsWith("/_matrix/media/");

		if (
			method === "POST" ||
			method === "PUT" ||
			method === "PATCH" ||
			method === "DELETE"
		) {
			const raw = await readBody(req);
			if (isMedia) {
				body = {};
				rawBody = raw;
			} else if (raw.length > 0) {
				const contentType = req.headers["content-type"] ?? "";
				if (!contentType.includes("application/json") && raw.length > 0) {
					respondJson(res, 400, {
						errcode: "M_NOT_JSON",
						error: "Content-Type must be application/json",
					});
					return;
				}
				try {
					body = JSON.parse(raw.toString("utf-8"));
				} catch {
					respondJson(res, 400, {
						errcode: "M_BAD_JSON",
						error: "Could not parse JSON body",
					});
					return;
				}
			} else {
				body = {};
			}
		}

		const routerReq: RouterRequest = {
			raw: req,
			method,
			path: url.pathname,
			params,
			query: url.searchParams,
			headers: req.headers,
			body,
			rawBody,
		};

		if (!matchedRoute) {
			const notFoundHandler: Handler = () => ({
				status: 404,
				body: { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" },
			});

			try {
				const response = await this.compose(
					this.globalMiddleware,
					notFoundHandler,
				)(routerReq);
				this.respond(res, response);
			} catch (err) {
				this.handleError(res, err);
			}
			return;
		}

		const allMiddleware = [
			...this.globalMiddleware,
			...matchedRoute.middleware,
		];
		try {
			const response = await this.compose(
				allMiddleware,
				matchedRoute.handler,
			)(routerReq);
			this.respond(res, response);
		} catch (err) {
			this.handleError(res, err);
		}
	}

	private compose(middleware: Middleware[], handler: Handler): Handler {
		return middleware.reduceRight<Handler>(
			(next, mw) => (req) => mw(req, next),
			handler,
		);
	}

	private respond(res: ServerResponse, response: RouterResponse): void {
		if (Buffer.isBuffer(response.body)) {
			res.writeHead(response.status, response.headers);
			res.end(response.body);
			return;
		}
		respondJson(res, response.status, response.body, response.headers);
	}

	private handleError(res: ServerResponse, err: unknown): void {
		if (err instanceof MatrixError) {
			respondJson(res, err.statusCode, err.toJSON());
			return;
		}
		console.error("Unhandled error:", err);
		respondJson(res, 500, {
			errcode: "M_UNKNOWN",
			error: "Internal server error",
		});
	}
}
