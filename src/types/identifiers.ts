// =============================================================================
// IDENTIFIERS
// =============================================================================

/** @example "@alice:example.com" */
export type UserId = string;

/** @example "!abc123:example.com" */
export type RoomId = string;

/** @example "#general:example.com" */
export type RoomAlias = string;

/** @example "$event_id" (v4+) or "$base64:example.com" (v1-v3) */
export type EventId = string;

/** Opaque device identifier */
export type DeviceId = string;

/** @example "example.com" or "example.com:8448" */
export type ServerName = string;

/** Client-provided transaction ID for idempotency */
export type TransactionId = string;

/** mxc:// URI for media */
export type MxcUri = string;

/** Base64-encoded bytes */
export type Base64 = string;

/** Unix timestamp in milliseconds */
export type Timestamp = number;

/** Integer stream position for sync tokens */
export type StreamPosition = number;

/** Opaque access token */
export type AccessToken = string;

/** Opaque refresh token */
export type RefreshToken = string;

/** Key ID in format "algorithm:identifier" e.g. "ed25519:AABBCC" */
export type KeyId = string;

/** Sender ID - UserId or pseudo-ID in rooms that use them */
export type SenderId = string;
