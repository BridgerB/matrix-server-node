import type { Middleware } from "../router.ts";

// Single source of truth for CORS policy. The router applies these headers to
// EVERY response it writes (success, media, thrown MatrixErrors, 500s,
// body-parse errors, unmatched 404/405) — see respondJson/respond in router.ts.
// A browser origin must see CORS headers on non-2xx responses too, or it blocks
// the read; key backup / cross-signing / secret-storage all probe with GETs
// that legitimately 404 before setup, so those must carry the headers.
export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Origin, X-Requested-With, Content-Type, Accept, Authorization",
};

// Short-circuit CORS preflight before it hits route matching / auth. The actual
// header application happens at the router's response layer, so this only needs
// to answer OPTIONS; the headers it sets are reapplied there anyway.
export const cors: Middleware = async (req, next) => {
	if (req.method === "OPTIONS") {
		return { status: 200, body: {}, headers: CORS_HEADERS };
	}
	return next(req);
};
