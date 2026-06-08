import { createHash, randomBytes } from "node:crypto";
import { MatrixError, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerName } from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";

const MAX_UPLOAD_SIZE = 52428800; // 50 MB

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
	(storage: Storage): Handler =>
	async (req) => {
		const serverName = req.params.serverName as ServerName;
		const mediaId = req.params.mediaId as string;

		const result = await storage.getMedia(serverName, mediaId);
		if (!result) throw notFound("Media not found");

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
	(storage: Storage): Handler =>
	async (req) => {
		const serverName = req.params.serverName as ServerName;
		const mediaId = req.params.mediaId as string;

		const result = await storage.getMedia(serverName, mediaId);
		if (!result) throw notFound("Media not found");

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
