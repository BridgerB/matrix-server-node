import type { Middleware } from "../router.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization",
};

export const cors: Middleware = async (req, next) => {
  if (req.method === "OPTIONS") {
    return { status: 200, body: {}, headers: CORS_HEADERS };
  }

  const response = await next(req);
  return {
    ...response,
    headers: { ...CORS_HEADERS, ...response.headers },
  };
};
