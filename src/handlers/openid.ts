import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import { generateToken } from "../crypto.ts";
import { forbidden } from "../errors.ts";

// =============================================================================
// POST /_matrix/client/v3/user/:userId/openid/request_token
// =============================================================================

export function postOpenIdToken(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const targetUserId = req.params["userId"]!;
    if (req.userId !== targetUserId) throw forbidden("Can only request tokens for yourself");

    const token = generateToken();
    const expiresIn = 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    await storage.storeOpenIdToken(token, req.userId!, expiresAt);

    return {
      status: 200,
      body: {
        access_token: token,
        token_type: "Bearer",
        matrix_server_name: serverName,
        expires_in: expiresIn,
      },
    };
  };
}
