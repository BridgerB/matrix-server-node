import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import { badJson } from "../errors.ts";

// =============================================================================
// GET /_matrix/client/v3/account/3pid
// =============================================================================

export function getThreePids(storage: Storage): Handler {
  return async (req) => {
    const threepids = await storage.getThreePids(req.userId!);
    return { status: 200, body: { threepids } };
  };
}

// =============================================================================
// POST /_matrix/client/v3/account/3pid/add
// =============================================================================

export function postAddThreePid(storage: Storage): Handler {
  return async (req) => {
    const body = (req.body ?? {}) as { medium?: string; address?: string };
    if (!body.medium || !body.address) throw badJson("Missing medium or address");

    await storage.addThreePid(req.userId!, body.medium, body.address);
    return { status: 200, body: {} };
  };
}

// =============================================================================
// POST /_matrix/client/v3/account/3pid/delete
// =============================================================================

export function postDeleteThreePid(storage: Storage): Handler {
  return async (req) => {
    const body = (req.body ?? {}) as { medium?: string; address?: string };
    if (!body.medium || !body.address) throw badJson("Missing medium or address");

    await storage.deleteThreePid(req.userId!, body.medium, body.address);
    return { status: 200, body: { id_server_unbind_result: "no-support" } };
  };
}
