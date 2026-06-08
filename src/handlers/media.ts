import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { resolveServer } from "../federation/discovery.ts";
import { MatrixError, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import { signJson, type SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerName } from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";

const MAX_UPLOAD_SIZE = 52428800; // 50 MB

/** Result of fetching media from a remote homeserver over federation. */
interface RemoteMedia {
	data: Buffer;
	contentType: string;
	fileName?: string;
}

/**
 * Make a signed federation GET request that returns the raw response bytes and
 * headers (the shared FederationClient decodes bodies as UTF-8/JSON, which would
 * corrupt binary media and drop the Content-Type header, so we issue the request
 * here instead).
 */
const signedFederationGet = (
	ourServerName: string,
	signingKey: SigningKey,
	destination: ServerName,
	path: string,
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> =>
	resolveServer(destination).then(
		(resolved) =>
			new Promise((resolve, reject) => {
				const requestObj: Record<string, unknown> = {
					method: "GET",
					uri: path,
					origin: ourServerName,
					destination,
				};
				signJson(requestObj, ourServerName, signingKey);
				const signatures = requestObj.signatures as Record<
					string,
					Record<string, string>
				>;
				const sig = signatures[ourServerName]?.[signingKey.keyId] as string;
				const authHeader = `X-Matrix origin="${ourServerName}",destination="${destination}",key="${signingKey.keyId}",sig="${sig}"`;

				const opts: RequestOptions = {
					hostname: resolved.host,
					port: resolved.port,
					path,
					method: "GET",
					headers: { Authorization: authHeader, Host: destination },
					timeout: 30000,
					rejectUnauthorized: false,
				};

				const httpReq = httpsRequest(opts, (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const headers: Record<string, string> = {};
						for (const [k, v] of Object.entries(res.headers)) {
							if (typeof v === "string") headers[k.toLowerCase()] = v;
							else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
						}
						resolve({
							status: res.statusCode ?? 500,
							body: Buffer.concat(chunks),
							headers,
						});
					});
				});
				httpReq.on("error", reject);
				httpReq.on("timeout", () => {
					httpReq.destroy();
					reject(new Error("Federation media request timeout"));
				});
				httpReq.end();
			}),
	);

/** Parse a header line's value, returning the bare media type and any `filename` param. */
const parseContentDisposition = (
	value: string,
): { isAttachment: boolean; fileName?: string } => {
	const semi = value.indexOf(";");
	const disp = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
	const isAttachment = disp === "attachment";
	// filename*=UTF-8''<pct-encoded> (RFC 5987)
	const ext = value.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
	if (ext?.[1]) {
		try {
			return { isAttachment, fileName: decodeURIComponent(ext[1].trim()) };
		} catch {
			/* fall through to plain filename */
		}
	}
	const quoted = value.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i);
	if (quoted?.[1] !== undefined) {
		return { isAttachment, fileName: quoted[1].replace(/\\(.)/g, "$1") };
	}
	const bare = value.match(/filename\s*=\s*([^;]+)/i);
	if (bare?.[1]) return { isAttachment, fileName: bare[1].trim() };
	return { isAttachment };
};

/**
 * Parse a federation media response. The spec requires multipart/mixed (first
 * part JSON metadata, second part the file), but some servers (and the
 * Complement test federation server) return the file bytes directly, so this
 * handles both. Returns the file bytes plus its Content-Type/filename.
 */
const parseFederationMediaResponse = (
	body: Buffer,
	responseContentType: string,
): RemoteMedia => {
	const ct = responseContentType.toLowerCase();
	if (!ct.startsWith("multipart/")) {
		// Non-multipart: body is the file directly.
		return {
			data: body,
			contentType: responseContentType || "application/octet-stream",
		};
	}

	const boundaryMatch = responseContentType.match(
		/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i,
	);
	const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
	if (!boundary) {
		return {
			data: body,
			contentType: "application/octet-stream",
		};
	}

	const delimiter = Buffer.from(`--${boundary}`);
	// Split the body on the boundary delimiter.
	const segments: Buffer[] = [];
	let searchStart = 0;
	let idx = body.indexOf(delimiter, searchStart);
	while (idx !== -1) {
		if (searchStart !== 0 || idx !== 0) {
			segments.push(body.subarray(searchStart, idx));
		}
		searchStart = idx + delimiter.length;
		idx = body.indexOf(delimiter, searchStart);
	}

	// Each segment after the preamble: skip leading CRLF, then headers \r\n\r\n body.
	const fileParts: { headers: Map<string, string>; data: Buffer }[] = [];
	for (let part of segments) {
		// Strip leading CRLF (or LF) that follows the boundary delimiter.
		if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
		else if (part[0] === 0x0a) part = part.subarray(1);
		// "--" immediately after boundary marks the closing delimiter.
		if (part.subarray(0, 2).toString() === "--") continue;
		const sep = part.indexOf("\r\n\r\n");
		if (sep === -1) continue;
		const headerBlock = part.subarray(0, sep).toString("utf-8");
		let data = part.subarray(sep + 4);
		// Trailing CRLF before the next boundary belongs to the delimiter, not the data.
		if (data.subarray(data.length - 2).toString() === "\r\n") {
			data = data.subarray(0, data.length - 2);
		}
		const headers = new Map<string, string>();
		for (const line of headerBlock.split("\r\n")) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			headers.set(
				line.slice(0, colon).trim().toLowerCase(),
				line.slice(colon + 1).trim(),
			);
		}
		fileParts.push({ headers, data });
	}

	// The file is the part whose Content-Type is not application/json (the first
	// part is JSON metadata). Fall back to the last part.
	const filePart =
		fileParts.find((p) => {
			const t = (p.headers.get("content-type") ?? "").toLowerCase();
			return !t.startsWith("application/json");
		}) ?? fileParts[fileParts.length - 1];

	if (!filePart) {
		return { data: Buffer.alloc(0), contentType: "application/octet-stream" };
	}

	const partCt = filePart.headers.get("content-type") ?? "application/octet-stream";
	const disposition = filePart.headers.get("content-disposition");
	const fileName = disposition
		? parseContentDisposition(disposition).fileName
		: undefined;
	return { data: filePart.data, contentType: partCt, fileName };
};

/**
 * Fetch media from its origin homeserver over federation. Tries the
 * authenticated federation media endpoint first, falling back to the legacy
 * unauthenticated download path. Returns undefined if the media cannot be found.
 */
const fetchRemoteMedia = async (
	ourServerName: string,
	signingKey: SigningKey,
	origin: ServerName,
	mediaId: string,
): Promise<RemoteMedia | undefined> => {
	const fedPath = `/_matrix/federation/v1/media/download/${encodeURIComponent(
		mediaId,
	)}?timeout_ms=20000`;
	try {
		const res = await signedFederationGet(
			ourServerName,
			signingKey,
			origin,
			fedPath,
		);
		if (res.status === 200) {
			return parseFederationMediaResponse(
				res.body,
				res.headers["content-type"] ?? "",
			);
		}
	} catch {
		/* try legacy path below */
	}

	// Legacy fallback: signed request to the v3 download endpoint.
	const legacyPath = `/_matrix/media/v3/download/${encodeURIComponent(
		origin,
	)}/${encodeURIComponent(mediaId)}?allow_remote=false`;
	try {
		const res = await signedFederationGet(
			ourServerName,
			signingKey,
			origin,
			legacyPath,
		);
		if (res.status === 200) {
			return parseFederationMediaResponse(
				res.body,
				res.headers["content-type"] ?? "",
			);
		}
	} catch {
		/* give up */
	}
	return undefined;
};

/** True if every character is printable US-ASCII (safe to put in an HTTP header). */
const isAsciiPrintable = (name: string): boolean =>
	[...name].every((ch) => {
		const c = ch.codePointAt(0) ?? 0;
		return c >= 0x20 && c < 0x7f;
	});

/** Percent-encode a string as UTF-8 per RFC 5987 (value-chars / attr-char only). */
const rfc5987Encode = (name: string): string =>
	[...Buffer.from(name, "utf-8")]
		.map((b) => {
			const ch = String.fromCharCode(b);
			return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch)
				? ch
				: `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		})
		.join("");

/**
 * Build a Content-Disposition header value that is always a valid ASCII header.
 * ASCII filenames use the quoted form; names with non-ASCII characters use the
 * RFC 5987 `filename*=UTF-8''…` extended form so they round-trip without throwing
 * ERR_INVALID_CHAR when written to the response.
 */
const contentDisposition = (fileName: string): string => {
	if (isAsciiPrintable(fileName)) {
		const escaped = fileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `inline; filename="${escaped}"`;
	}
	return `inline; filename*=UTF-8''${rfc5987Encode(fileName)}`;
};

export const postUpload =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const data = req.rawBody ?? Buffer.alloc(0);

		if (data.length > MAX_UPLOAD_SIZE)
			throw new MatrixError(
				"M_TOO_LARGE",
				`Upload exceeds maximum size of ${MAX_UPLOAD_SIZE} bytes`,
				413,
			);

		const contentType =
			req.headers["content-type"] ?? "application/octet-stream";
		const filename = req.query.get("filename") ?? undefined;
		const mediaId = randomBytes(18).toString("base64url");

		const hash = createHash("sha256").update(data).digest("base64");

		const media: StoredMedia = {
			media_id: mediaId,
			origin: serverName as ServerName,
			user_id: userId,
			content_type: contentType,
			upload_name: filename,
			file_size: data.length,
			content_hash: hash,
			created_at: Date.now(),
			quarantined: false,
		};

		await storage.storeMedia(media, data);

		return {
			status: 200,
			body: { content_uri: `mxc://${serverName}/${mediaId}` },
		};
	};

export const getDownload =
	(
		storage: Storage,
		ourServerName?: string,
		signingKey?: SigningKey,
	): Handler =>
	async (req) => {
		const serverName = req.params.serverName as ServerName;
		const mediaId = req.params.mediaId as string;

		const result = await storage.getMedia(serverName, mediaId);

		if (!result) {
			// Media lives on a remote server: fetch it over federation.
			if (
				ourServerName &&
				signingKey &&
				serverName !== ourServerName
			) {
				const remote = await fetchRemoteMedia(
					ourServerName,
					signingKey,
					serverName,
					mediaId,
				);
				if (!remote) throw notFound("Media not found");

				// Cache locally so subsequent requests are served directly.
				try {
					const media: StoredMedia = {
						media_id: mediaId,
						origin: serverName,
						user_id: undefined,
						content_type: remote.contentType,
						upload_name: remote.fileName,
						file_size: remote.data.length,
						content_hash: createHash("sha256")
							.update(remote.data)
							.digest("base64"),
						created_at: Date.now(),
						quarantined: false,
					};
					await storage.storeMedia(media, remote.data);
				} catch {
					/* caching is best-effort */
				}

				const headers: Record<string, string> = {
					"Content-Type": remote.contentType,
					"Content-Length": String(remote.data.length),
					"Content-Security-Policy": "sandbox",
				};
				const fileName = req.params.fileName ?? remote.fileName;
				if (fileName) {
					headers["Content-Disposition"] = contentDisposition(fileName);
				}
				return { status: 200, body: remote.data, headers };
			}
			throw notFound("Media not found");
		}

		const { metadata, data } = result;

		// If media was created via POST /media/v1/create but not yet uploaded, return 504
		if (metadata.file_size === 0) {
			return {
				status: 504,
				body: {
					errcode: "M_NOT_YET_UPLOADED",
					error: "Content has not yet been uploaded",
				},
			};
		}

		const headers: Record<string, string> = {
			"Content-Type": metadata.content_type,
			"Content-Length": String(data.length),
			"Content-Security-Policy": "sandbox",
		};

		const fileName = req.params.fileName ?? metadata.upload_name;
		if (fileName) {
			headers["Content-Disposition"] = contentDisposition(fileName);
		}

		return { status: 200, body: data, headers };
	};

export const getThumbnail =
	(
		storage: Storage,
		ourServerName?: string,
		signingKey?: SigningKey,
	): Handler =>
	async (req) => {
		const serverName = req.params.serverName as ServerName;
		const mediaId = req.params.mediaId as string;

		const result = await storage.getMedia(serverName, mediaId);

		if (!result) {
			if (
				ourServerName &&
				signingKey &&
				serverName !== ourServerName
			) {
				const remote = await fetchRemoteMedia(
					ourServerName,
					signingKey,
					serverName,
					mediaId,
				);
				if (!remote) throw notFound("Media not found");
				return {
					status: 200,
					body: remote.data,
					headers: {
						"Content-Type": remote.contentType,
						"Content-Length": String(remote.data.length),
						"Content-Security-Policy": "sandbox",
					},
				};
			}
			throw notFound("Media not found");
		}

		const { metadata, data } = result;

		if (metadata.file_size === 0) {
			return {
				status: 504,
				body: {
					errcode: "M_NOT_YET_UPLOADED",
					error: "Content has not yet been uploaded",
				},
			};
		}

		return {
			status: 200,
			body: data,
			headers: {
				"Content-Type": metadata.content_type,
				"Content-Length": String(data.length),
				"Content-Security-Policy": "sandbox",
			},
		};
	};

export const postCreateMedia =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const mediaId = randomBytes(18).toString("base64url");

		const media: StoredMedia = {
			media_id: mediaId,
			origin: serverName as ServerName,
			user_id: userId,
			content_type: "application/octet-stream",
			upload_name: undefined,
			file_size: 0,
			content_hash: "",
			created_at: Date.now(),
			quarantined: false,
		};

		await storage.reserveMedia(media);

		const unusedExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

		return {
			status: 200,
			body: {
				content_uri: `mxc://${serverName}/${mediaId}`,
				unused_expires_at: unusedExpiresAt,
			},
		};
	};

export const putAsyncUpload =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as string;
		const reqServerName = req.params.serverName!;
		const mediaId = req.params.mediaId!;

		if (reqServerName !== serverName) {
			throw new MatrixError(
				"M_FORBIDDEN",
				"Cannot upload media to a different server",
				403,
			);
		}

		const existing = await storage.getMedia(
			serverName as ServerName,
			mediaId,
		);
		if (!existing) throw notFound("Media not found");

		if (existing.metadata.user_id !== userId) {
			throw new MatrixError(
				"M_FORBIDDEN",
				"Cannot upload to media created by another user",
				403,
			);
		}

		if (existing.metadata.file_size > 0) {
			throw new MatrixError(
				"M_CANNOT_OVERWRITE_MEDIA",
				"Media has already been uploaded",
				409,
			);
		}

		const data = req.rawBody ?? Buffer.alloc(0);

		if (data.length === 0) {
			throw new MatrixError(
				"M_BAD_JSON",
				"No content provided",
				400,
			);
		}

		if (data.length > MAX_UPLOAD_SIZE) {
			throw new MatrixError(
				"M_TOO_LARGE",
				`Upload exceeds maximum size of ${MAX_UPLOAD_SIZE} bytes`,
				413,
			);
		}

		const contentType =
			req.headers["content-type"] ?? "application/octet-stream";
		const filename = req.query.get("filename") ?? undefined;

		await storage.updateMediaContent(
			serverName as ServerName,
			mediaId,
			contentType,
			filename,
			data,
		);

		return {
			status: 200,
			body: { content_uri: `mxc://${serverName}/${mediaId}` },
		};
	};

export const getConfig = (): Handler => () => ({
	status: 200,
	body: { "m.upload.size": MAX_UPLOAD_SIZE },
});
