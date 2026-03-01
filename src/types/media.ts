// =============================================================================
// MEDIA API
// =============================================================================

import type { MxcUri } from "./identifiers.ts";

export interface MediaUploadResponse {
  content_uri: MxcUri;
}

export interface MediaConfig {
  "m.upload.size"?: number;
}

export interface UrlPreview {
  "og:title"?: string;
  "og:description"?: string;
  "og:image"?: MxcUri;
  "og:image:type"?: string;
  "og:image:width"?: number;
  "og:image:height"?: number;
  "matrix:image:size"?: number;
}

export type ThumbnailMethod = "crop" | "scale";

export interface MediaMetadata {
  content_type: string;
  content_disposition?: string;
}
