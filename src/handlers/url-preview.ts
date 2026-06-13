import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { forbidden, invalidParam, missingParam } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ServerName } from "../types/index.ts";
import type { StoredMedia } from "../types/internal.ts";

/**
 * Check if an IP address is private/internal (SSRF protection).
 */
function isPrivateIp(ip: string): boolean {
	// IPv4 private ranges
	if (ip.startsWith("10.") || ip.startsWith("127.") || ip === "0.0.0.0")
		return true;
	if (ip.startsWith("172.")) {
		const second = parseInt(ip.split(".")[1] ?? "0", 10);
		if (second >= 16 && second <= 31) return true;
	}
	if (ip.startsWith("192.168.")) return true;
	if (ip.startsWith("169.254.")) return true;
	// IPv6 loopback and private
	if (ip === "::1" || ip === "::") return true;
	if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80"))
		return true;
	return false;
}

const MAX_RESPONSE_SIZE = 50 * 1024; // 50KB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Parse OpenGraph meta tags from an HTML string.
 * Looks for <meta property="og:..." content="..." /> patterns.
 */
function parseOpenGraphTags(html: string): Record<string, string> {
	const result: Record<string, string> = {};

	// Match <meta property="og:..." content="..." /> in various forms
	const metaRegex =
		/<meta\s+[^>]*?(?:property|name)\s*=\s*["']?(og:[^"'\s>]+)["']?\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*\/?>/gi;
	const metaRegexAlt =
		/<meta\s+[^>]*?content\s*=\s*["']([^"']*)["']\s+[^>]*?(?:property|name)\s*=\s*["']?(og:[^"'\s>]+)["']?[^>]*\/?>/gi;

	let match: RegExpExecArray | null;

	match = metaRegex.exec(html);
	while (match) {
		const key = match[1];
		const value = match[2];
		if (key && value) {
			result[key] = value;
		}
		match = metaRegex.exec(html);
	}

	match = metaRegexAlt.exec(html);
	while (match) {
		const value = match[1];
		const key = match[2];
		if (key && value && !(key in result)) {
			result[key] = value;
		}
		match = metaRegexAlt.exec(html);
	}

	// If no og:title, try to extract <title>
	if (!result["og:title"]) {
		const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
		if (titleMatch?.[1]) {
			result["og:title"] = titleMatch[1].trim();
		}
	}

	return result;
}

/**
 * Fetch a URL with timeout, following up to 3 redirects.
 * Returns the response body as a Buffer (limited to maxSize) plus content type.
 */
function fetchUrlRaw(
	url: string,
	maxSize: number,
	maxRedirects = 3,
): Promise<{ body: Buffer; contentType: string }> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;

		const req = transport.request(
			url,
			{
				method: "GET",
				headers: {
					"User-Agent": "Matrix-Homeserver/1.0 URL-Preview",
					Accept: "text/html,application/xhtml+xml,*/*",
				},
				timeout: FETCH_TIMEOUT_MS,
				rejectUnauthorized: false,
			},
			(res) => {
				// Handle redirects
				if (
					(res.statusCode === 301 ||
						res.statusCode === 302 ||
						res.statusCode === 303 ||
						res.statusCode === 307 ||
						res.statusCode === 308) &&
					res.headers.location
				) {
					res.resume(); // drain the response
					if (maxRedirects <= 0) {
						reject(new Error("Too many redirects"));
						return;
					}
					let redirectUrl = res.headers.location;
					// Handle relative redirects
					if (redirectUrl.startsWith("/")) {
						redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
					} else if (!/^https?:\/\//i.test(redirectUrl)) {
						redirectUrl = new URL(redirectUrl, url).toString();
					}
					fetchUrlRaw(redirectUrl, maxSize, maxRedirects - 1).then(
						resolve,
						reject,
					);
					return;
				}

				if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
					res.resume();
					reject(new Error(`HTTP error: ${res.statusCode.toString()}`));
					return;
				}

				const contentType = res.headers["content-type"] ?? "text/html";
				const chunks: Buffer[] = [];
				let totalSize = 0;

				res.on("data", (chunk: Buffer) => {
					totalSize += chunk.length;
					if (totalSize <= maxSize) {
						chunks.push(chunk);
					}
				});

				res.on("end", () => {
					resolve({
						body: Buffer.concat(chunks),
						contentType,
					});
				});

				res.on("error", reject);
			},
		);

		req.on("timeout", () => {
			req.destroy(new Error("Request timeout"));
		});

		req.on("error", reject);
		req.end();
	});
}

/**
 * Decode HTML entities like &amp; &lt; &#39; etc.
 */
function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#(\d+);/g, (_m, code) =>
			String.fromCharCode(parseInt(code as string, 10)),
		);
}

/**
 * Extract image dimensions from common image formats by inspecting the bytes.
 * Supports PNG, GIF, and JPEG. Returns undefined if dimensions can't be read.
 */
function getImageDimensions(
	buf: Buffer,
): { width: number; height: number } | undefined {
	// PNG: signature 0x89 P N G, IHDR width/height are big-endian uint32 at offset 16/20
	if (
		buf.length >= 24 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47
	) {
		return {
			width: buf.readUInt32BE(16),
			height: buf.readUInt32BE(20),
		};
	}

	// GIF: "GIF8", width/height are little-endian uint16 at offset 6/8
	if (
		buf.length >= 10 &&
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x38
	) {
		return {
			width: buf.readUInt16LE(6),
			height: buf.readUInt16LE(8),
		};
	}

	// JPEG: starts with 0xFFD8, scan for SOFn marker
	if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < buf.length) {
			if (buf[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = buf[offset + 1] ?? 0;
			// SOF0..SOF15 (excluding non-SOF markers 0xC4,0xC8,0xCC)
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					height: buf.readUInt16BE(offset + 5),
					width: buf.readUInt16BE(offset + 7),
				};
			}
			const segLen = buf.readUInt16BE(offset + 2);
			offset += 2 + segLen;
		}
	}

	return undefined;
}

/**
 * Resolve a possibly-private hostname for SSRF protection.
 * Throws (forbidden) if the host resolves to a private IP.
 */
async function assertPublicHost(hostname: string): Promise<void> {
	// Allow private targets when explicitly enabled (e.g. Complement, which serves
	// the previewed page from a private Docker IP). Production keeps SSRF blocking.
	if (process.env.URL_PREVIEW_ALLOW_PRIVATE_IPS === "1") return;
	const { address } = await lookup(hostname);
	if (isPrivateIp(address)) {
		throw forbidden("URL resolves to a private IP address");
	}
}

export const getUrlPreview =
	(storage?: Storage, serverName?: string): Handler =>
	async (req) => {
		const url = req.query.get("url");
		if (!url) throw missingParam("Missing required 'url' parameter");

		// Validate URL scheme
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			throw invalidParam("Invalid URL");
		}

		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			throw invalidParam("URL must use http or https scheme");
		}

		// SSRF protection: resolve hostname and block private IPs
		try {
			await assertPublicHost(parsedUrl.hostname);
		} catch (err) {
			if (err instanceof Error && err.message.includes("private IP")) throw err;
			throw invalidParam("Could not resolve URL hostname");
		}

		try {
			const { body, contentType } = await fetchUrlRaw(url, MAX_RESPONSE_SIZE);

			// Only parse HTML content
			if (
				!contentType.includes("text/html") &&
				!contentType.includes("application/xhtml")
			) {
				return {
					status: 200,
					body: { "og:title": parsedUrl.hostname },
				};
			}

			const ogTags = parseOpenGraphTags(body.toString("utf-8"));

			// Build response with decoded entities
			const result: Record<string, string | number> = {};
			for (const [key, value] of Object.entries(ogTags)) {
				result[key] = decodeHtmlEntities(value);
			}

			// If there is an og:image, download it, store it as media, and
			// rewrite og:image to the resulting mxc:// URI. Also populate
			// matrix:image:size and og:image:width/height.
			const ogImage = ogTags["og:image"];
			if (ogImage && storage && serverName) {
				try {
					const imageUrl = new URL(decodeHtmlEntities(ogImage), url);
					if (imageUrl.protocol === "http:" || imageUrl.protocol === "https:") {
						await assertPublicHost(imageUrl.hostname);
						const img = await fetchUrlRaw(imageUrl.toString(), MAX_IMAGE_SIZE);

						const mediaId = randomBytes(18).toString("base64url");
						const hash = createHash("sha256").update(img.body).digest("base64");
						const media: StoredMedia = {
							media_id: mediaId,
							origin: serverName as ServerName,
							user_id: req.userId as string | undefined,
							content_type: img.contentType,
							upload_name: imageUrl.pathname.split("/").pop(),
							file_size: img.body.length,
							content_hash: hash,
							created_at: Date.now(),
							quarantined: false,
						};
						await storage.storeMedia(media, img.body);

						result["og:image"] = `mxc://${serverName}/${mediaId}`;
						result["matrix:image:size"] = img.body.length;

						const dims = getImageDimensions(img.body);
						if (dims) {
							result["og:image:width"] = dims.width;
							result["og:image:height"] = dims.height;
						}
					}
				} catch {
					// Image fetch/store failed: leave og:image as the raw value.
				}
			}

			return { status: 200, body: result };
		} catch {
			// If we can't fetch, return empty object
			return { status: 200, body: {} };
		}
	};
