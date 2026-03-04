import { randomBytes, createHash } from "node:crypto";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerName } from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";
import { MatrixError, notFound } from "../errors.ts";

const MAX_UPLOAD_SIZE = 52428800; // 50 MB

export function postUpload(storage: Storage, serverName: string): Handler {
	return async (req) => {
		const userId = req.userId!;
		const data = req.rawBody ?? Buffer.alloc(0);

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
}

export function getDownload(storage: Storage): Handler {
	return async (req) => {
		const serverName = req.params["serverName"]! as ServerName;
		const mediaId = req.params["mediaId"]!;

		const result = await storage.getMedia(serverName, mediaId);
		if (!result) throw notFound("Media not found");

		const { metadata, data } = result;
		const headers: Record<string, string> = {
			"Content-Type": metadata.content_type,
			"Content-Length": String(data.length),
		};

		// Use filename from path param or original upload name
		const fileName = req.params["fileName"] ?? metadata.upload_name;
		if (fileName) {
			headers["Content-Disposition"] = `inline; filename="${fileName}"`;
		}

		return { status: 200, body: data, headers };
	};
}

export function getThumbnail(storage: Storage): Handler {
	return async (req) => {
		const serverName = req.params["serverName"]! as ServerName;
		const mediaId = req.params["mediaId"]!;

		const result = await storage.getMedia(serverName, mediaId);
		if (!result) throw notFound("Media not found");

		// Simplified: return original file (no resizing)
		const { metadata, data } = result;
		return {
			status: 200,
			body: data,
			headers: {
				"Content-Type": metadata.content_type,
				"Content-Length": String(data.length),
			},
		};
	};
}

export function getConfig(): Handler {
	return () => ({
		status: 200,
		body: { "m.upload.size": MAX_UPLOAD_SIZE },
	});
}
