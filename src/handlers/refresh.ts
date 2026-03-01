import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import { badJson, unknownToken } from "../errors.ts";
import { generateToken } from "../crypto.ts";

export function postRefresh(storage: Storage): Handler {
  return async (req) => {
    const body = req.body as { refresh_token?: string };

    if (!body.refresh_token) throw badJson("Missing 'refresh_token' field");

    const session = await storage.getSessionByRefreshToken(body.refresh_token);
    if (!session) throw unknownToken("Unknown refresh token");

    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = Date.now() + 300_000;

    const updated = await storage.rotateToken(
      session.access_token,
      newAccessToken,
      newRefreshToken,
      expiresAt,
    );

    if (!updated) throw unknownToken("Session no longer exists");

    return {
      status: 200,
      body: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in_ms: 300_000,
      },
    };
  };
}
