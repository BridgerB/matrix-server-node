import { createHash, randomBytes } from "node:crypto";
import { MatrixError, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerName } from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";

const MAX_UPLOAD_SIZE = 52428800; // 50 MB

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
		const headers: Record<string, string> = {
			"Content-Type": metadata.content_type,
			"Content-Length": String(data.length),
			"Content-Security-Policy": "sandbox",
		};

		const fileName = req.params.fileName ?? metadata.upload_name;
		if (fileName) {
			headers["Content-Disposition"] = `inline; filename="${fileName}"`;
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
