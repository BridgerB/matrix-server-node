import type { Handler } from "../router.ts";
import type { VersionsResponse, WellKnown } from "../types/index.ts";

export function versionsHandler(_serverName: string): Handler {
  const body: VersionsResponse = {
    versions: [
      "v1.1", "v1.2", "v1.3", "v1.4", "v1.5",
      "v1.6", "v1.7", "v1.8", "v1.9", "v1.10",
      "v1.11", "v1.12", "v1.13", "v1.14",
    ],
    unstable_features: {},
  };
  return async () => ({ status: 200, body });
}

export function wellKnownServerHandler(serverName: string): Handler {
  const body = { "m.server": `${serverName}:8448` };
  return async () => ({ status: 200, body });
}

export function wellKnownClientHandler(serverName: string): Handler {
  const body: WellKnown = {
    "m.homeserver": { base_url: `https://${serverName}` },
  };
  return async () => ({ status: 200, body });
}
