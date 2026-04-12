import { randomBytes } from "node:crypto";
import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { ServerName } from "../../types/index.ts";

const buildMultipartResponse = (
	contentType: string,
	fileName: string | undefined,
	data: Buffer,
): { body: Buffer; boundary: string } => {
	const boundary = randomBytes(16).toString("hex");
	const parts: Buffer[] = [];

	// Part 1: JSON metadata
	parts.push(Buffer.from(`--${boundary}\r\n`));
	parts.push(Buffer.from("Content-Type: application/json\r\n\r\n"));
	parts.push(Buffer.from("{}\r\n"));

	// Part 2: Media content
	parts.push(Buffer.from(`--${boundary}\r\n`));
	parts.push(Buffer.from(`Content-Type: ${contentType}\r\n`));
	if (fileName) {
		parts.push(
			Buffer.from(`Content-Disposition: inline; filename="${fileName}"\r\n`),
		);
	}
	parts.push(Buffer.from("\r\n"));
	parts.push(data);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

	return { body: Buffer.concat(parts), boundary };
};

const serveFederationMedia =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const mediaId = req.params.mediaId!;

		const result = await storage.getMedia(serverName as ServerName, mediaId);
		if (!result) throw notFound("Media not found");

		const { metadata, data } = result;

		if (metadata.file_size === 0) {
			throw notFound("Media not yet uploaded");
		}

		const { body, boundary } = buildMultipartResponse(
			metadata.content_type,
			metadata.upload_name,
			data,
		);

		return {
			status: 200,
			body,
			headers: {
				"Content-Type": `multipart/mixed; boundary=${boundary}`,
				"Content-Length": String(body.length),
			},
		};
	};

export const getFederationMediaDownload = serveFederationMedia;
export const getFederationMediaThumbnail = serveFederationMedia;
