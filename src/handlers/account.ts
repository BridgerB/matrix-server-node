import type { Handler } from "../router.ts";
import type { WhoAmIResponse } from "../types/index.ts";

export function getWhoAmI(): Handler {
  return async (req) => {
    const body: WhoAmIResponse = {
      user_id: req.userId!,
      device_id: req.deviceId,
    };
    return { status: 200, body };
  };
}
