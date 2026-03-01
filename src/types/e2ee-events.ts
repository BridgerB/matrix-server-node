// =============================================================================
// EVENT CONTENT TYPES - E2EE / KEYS
// =============================================================================

import type { RoomId, DeviceId } from "./identifiers.ts";

export interface RoomKeyContent {
  algorithm: "m.megolm.v1.aes-sha2";
  room_id: RoomId;
  session_id: string;
  session_key: string;
}

export interface RoomKeyRequestContent {
  action: "request" | "request_cancellation";
  body?: {
    algorithm: string;
    room_id: RoomId;
    sender_key: string;
    session_id: string;
  };
  request_id: string;
  requesting_device_id: DeviceId;
}

export interface ForwardedRoomKeyContent {
  algorithm: "m.megolm.v1.aes-sha2";
  room_id: RoomId;
  sender_key: string;
  session_id: string;
  session_key: string;
  sender_claimed_ed25519_key: string;
  forwarding_curve25519_key_chain: string[];
}

export interface SecretRequestContent {
  action: "request" | "request_cancellation";
  name?: string;
  request_id: string;
  requesting_device_id: DeviceId;
}

export interface SecretSendContent {
  request_id: string;
  secret: string;
}
