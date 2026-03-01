// =============================================================================
// EVENT CONTENT TYPES - SPACES
// =============================================================================

import type { ServerName } from "./identifiers.ts";

export interface SpaceChildContent {
  via?: ServerName[];
  order?: string;
  suggested?: boolean;
}

export interface SpaceParentContent {
  via?: ServerName[];
  canonical?: boolean;
}
