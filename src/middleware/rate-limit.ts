import type { Middleware } from "../router.ts";

interface TokenBucket {
	tokens: number;
	lastRefill: number;
}

interface RateLimitConfig {
	maxTokens: number;
	refillRate: number; // tokens per millisecond
}

const RATE_CONFIGS: Record<string, RateLimitConfig> = {
	login: { maxTokens: 5, refillRate: 5 / 60_000 }, // 5 per minute
	register: { maxTokens: 3, refillRate: 3 / 60_000 }, // 3 per minute
	default: { maxTokens: 60, refillRate: 60 / 60_000 }, // 60 per minute
};

const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes
const STALE_THRESHOLD = 10 * 60_000; // 10 minutes

const buckets = new Map<string, TokenBucket>();
let lastCleanup = Date.now();

const cleanup = (now: number): void => {
	if (now - lastCleanup < CLEANUP_INTERVAL) return;
	lastCleanup = now;
	for (const [key, bucket] of buckets) {
		if (now - bucket.lastRefill > STALE_THRESHOLD) {
			buckets.delete(key);
		}
	}
};

const RATE_LIMIT_DISABLED = process.env.DISABLE_RATE_LIMIT === "1";

export const rateLimit = (category: string): Middleware => {
	const config = RATE_CONFIGS[category] ?? RATE_CONFIGS["default"]!;

	return async (req, next) => {
		if (RATE_LIMIT_DISABLED) return next(req);
		const ip = req.raw.socket.remoteAddress ?? "unknown";
		const key = `${ip}:${category}`;
		const now = Date.now();

		cleanup(now);

		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { tokens: config.maxTokens, lastRefill: now };
			buckets.set(key, bucket);
		}

		// Refill tokens based on elapsed time
		const elapsed = now - bucket.lastRefill;
		bucket.tokens = Math.min(
			config.maxTokens,
			bucket.tokens + elapsed * config.refillRate,
		);
		bucket.lastRefill = now;

		if (bucket.tokens < 1) {
			const waitMs = Math.ceil((1 - bucket.tokens) / config.refillRate);
			return {
				status: 429,
				body: {
					errcode: "M_LIMIT_EXCEEDED",
					error: "Too many requests",
					retry_after_ms: waitMs,
				},
			};
		}

		bucket.tokens -= 1;
		return next(req);
	};
};
