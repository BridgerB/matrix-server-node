import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { LoginRequest, LoginResponse, LoginFlow } from "../types/index.ts";
import { forbidden, badJson, invalidParam } from "../errors.ts";
import { generateToken, generateDeviceId } from "../crypto.ts";

const SUPPORTED_FLOWS: LoginFlow[] = [
  { type: "m.login.password" },
];

export function getLoginFlows(): Handler {
  return async () => ({
    status: 200,
    body: { flows: SUPPORTED_FLOWS },
  });
}

export function postLogin(storage: Storage, serverName: string): Handler {
  return async (req) => {
    const body = req.body as LoginRequest;

    if (!body.type) throw badJson("Missing 'type' field");
    if (body.type !== "m.login.password") {
      throw invalidParam(`Unsupported login type: ${body.type}`);
    }

    if (!body.identifier || body.identifier.type !== "m.id.user") {
      throw invalidParam("Only m.id.user identifier is supported");
    }

    let localpart = body.identifier.user;
    if (localpart.startsWith("@")) {
      const colonIdx = localpart.indexOf(":");
      localpart = colonIdx > 0 ? localpart.slice(1, colonIdx) : localpart.slice(1);
    }

    const account = await storage.getUserByLocalpart(localpart);
    if (!account) throw forbidden("Invalid username or password");
    if (account.is_deactivated) throw forbidden("This account has been deactivated");

    // TODO: replace with argon2 verification
    if (body.password !== account.password_hash) {
      throw forbidden("Invalid username or password");
    }

    const deviceId = body.device_id ?? generateDeviceId();
    const accessToken = generateToken();
    const refreshToken = body.refresh_token ? generateToken() : undefined;

    await storage.createSession({
      device_id: deviceId,
      user_id: account.user_id,
      access_token: accessToken,
      access_token_hash: "",
      refresh_token: refreshToken,
      display_name: body.initial_device_display_name,
      last_seen_ip: req.raw.socket.remoteAddress ?? "unknown",
      last_seen_ts: Date.now(),
      user_agent: (req.headers["user-agent"] as string) ?? "",
    });

    const response: LoginResponse = {
      user_id: account.user_id,
      access_token: accessToken,
      device_id: deviceId,
      well_known: {
        "m.homeserver": { base_url: `https://${serverName}` },
      },
    };

    if (refreshToken) {
      response.refresh_token = refreshToken;
      response.expires_in_ms = 300_000;
    }

    return { status: 200, body: response };
  };
}
