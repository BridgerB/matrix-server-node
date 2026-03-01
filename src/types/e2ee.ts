// =============================================================================
// E2EE - DEVICE KEYS, CROSS-SIGNING, KEY BACKUP
// =============================================================================

import type { UserId, DeviceId, KeyId, Base64, ServerName, RoomId } from "./identifiers.ts";
import type { JsonObject } from "./json.ts";

export type Signatures = Record<string, Record<KeyId, Base64>>;

export interface DeviceKeys {
  user_id: UserId;
  device_id: DeviceId;
  algorithms: string[];
  keys: Record<KeyId, string>; // "algorithm:device_id" -> key
  signatures: Signatures;
}

export interface OneTimeKey {
  key: string;
  signatures?: Signatures;
}

export interface CrossSigningKey {
  user_id: UserId;
  usage: ("master" | "self_signing" | "user_signing")[];
  keys: Record<KeyId, string>;
  signatures?: Signatures;
}

export interface KeysUploadRequest {
  device_keys?: DeviceKeys;
  one_time_keys?: Record<KeyId, string | OneTimeKey>;
  fallback_keys?: Record<KeyId, string | OneTimeKey>;
}

export interface KeysUploadResponse {
  one_time_key_counts: Record<string, number>;
}

export interface KeysQueryRequest {
  timeout?: number;
  device_keys: Record<UserId, DeviceId[]>;
}

export interface KeysQueryResponse {
  device_keys: Record<UserId, Record<DeviceId, DeviceKeys>>;
  master_keys?: Record<UserId, CrossSigningKey>;
  self_signing_keys?: Record<UserId, CrossSigningKey>;
  user_signing_keys?: Record<UserId, CrossSigningKey>;
  failures?: Record<ServerName, JsonObject>;
}

export interface KeysClaimRequest {
  timeout?: number;
  one_time_keys: Record<UserId, Record<DeviceId, string>>; // algorithm
}

export interface KeysClaimResponse {
  one_time_keys: Record<UserId, Record<DeviceId, Record<KeyId, string | OneTimeKey>>>;
  failures?: Record<ServerName, JsonObject>;
}

export interface KeyChangesResponse {
  changed: UserId[];
  left: UserId[];
}

// =============================================================================
// KEY BACKUP
// =============================================================================

export interface RoomKeyBackup {
  version: string;
  algorithm: string;
  auth_data: JsonObject;
  count: number;
  etag: string;
}

export interface KeyBackupData {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: JsonObject;
}

export interface RoomKeyBackupSessionData {
  rooms: Record<RoomId, {
    sessions: Record<string, KeyBackupData>;
  }>;
}
