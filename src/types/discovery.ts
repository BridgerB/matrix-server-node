// =============================================================================
// WELL-KNOWN, VERSIONS, CAPABILITIES & VOIP
// =============================================================================

import type { JsonValue } from "./json.ts";
import type { RoomVersionCapability } from "./room-versions.ts";

export interface WellKnown {
  "m.homeserver": { base_url: string };
  "m.identity_server"?: { base_url: string };
  "m.tile_server"?: { map_style_url: string };
  "org.matrix.msc3575.proxy"?: { url: string };
}

export interface VersionsResponse {
  versions: string[];
  unstable_features?: Record<string, boolean>;
}

export interface KnownCapabilities {
  "m.change_password"?: { enabled: boolean };
  "m.room_versions"?: RoomVersionCapability;
  "m.set_displayname"?: { enabled: boolean };
  "m.set_avatar_url"?: { enabled: boolean };
  "m.3pid_changes"?: { enabled: boolean };
  "m.get_login_token"?: { enabled: boolean };
}

export type Capabilities = KnownCapabilities & Record<string, JsonValue>;

export interface CapabilitiesResponse {
  capabilities: Capabilities;
}

export interface TurnServerResponse {
  username: string;
  password: string;
  uris: string[];
  ttl: number;
}
