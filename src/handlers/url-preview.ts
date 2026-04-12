import * as http from "node:http";
import * as https from "node:https";
import { invalidParam, missingParam } from "../errors.ts";
import type { Handler } from "../router.ts";

const MAX_RESPONSE_SIZE = 50 * 1024; // 50KB
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
 * Returns the response body as a string (limited to MAX_RESPONSE_SIZE).
 */
function fetchUrl(
	url: string,
	maxRedirects = 3,
): Promise<{ body: string; contentType: string }> {
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
					}
					fetchUrl(redirectUrl, maxRedirects - 1).then(resolve, reject);
					return;
				}

				if (
					res.statusCode &&
					(res.statusCode < 200 || res.statusCode >= 400)
				) {
					res.resume();
					reject(
						new Error(`HTTP error: ${res.statusCode.toString()}`),
					);
					return;
				}

				const contentType =
					res.headers["content-type"] ?? "text/html";
				const chunks: Buffer[] = [];
				let totalSize = 0;

				res.on("data", (chunk: Buffer) => {
					totalSize += chunk.length;
					if (totalSize <= MAX_RESPONSE_SIZE) {
						chunks.push(chunk);
					}
				});

				res.on("end", () => {
					resolve({
						body: Buffer.concat(chunks).toString("utf-8"),
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

export const getUrlPreview = (): Handler => async (req) => {
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

	try {
		const { body, contentType } = await fetchUrl(url);

		// Only parse HTML content
		if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
			return {
				status: 200,
				body: { "og:title": parsedUrl.hostname },
			};
		}

		const ogTags = parseOpenGraphTags(body);

		// Build response with decoded entities
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(ogTags)) {
			result[key] = decodeHtmlEntities(value);
		}

		return { status: 200, body: result };
	} catch {
		// If we can't fetch, return empty object
		return { status: 200, body: {} };
	}
};
