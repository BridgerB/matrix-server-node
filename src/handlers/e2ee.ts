import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId, DeviceId } from "../types/index.ts";
import type { KeysUploadRequest, KeysQueryRequest, KeysClaimRequest, DeviceKeys } from "../types/e2ee.ts";
import type { JsonObject } from "../types/json.ts";
import { badJson } from "../errors.ts";

// =============================================================================
// POST /_matrix/client/v3/keys/upload
// =============================================================================

export function postKeysUpload(storage: Storage): Handler {
  return async (req) => {
    const userId = req.userId!;
    const deviceId = req.deviceId!;
    const body = (req.body ?? {}) as KeysUploadRequest;

    // Store device keys
    if (body.device_keys) {
      if (body.device_keys.user_id !== userId || body.device_keys.device_id !== deviceId) {
        throw badJson("device_keys user_id/device_id must match authenticated user");
      }
      await storage.setDeviceKeys(userId, deviceId, body.device_keys);
    }

    // Add one-time keys
    if (body.one_time_keys && Object.keys(body.one_time_keys).length > 0) {
      await storage.addOneTimeKeys(userId, deviceId, body.one_time_keys);
    }

    // Set fallback keys (replaces previous)
    if (body.fallback_keys && Object.keys(body.fallback_keys).length > 0) {
      await storage.setFallbackKeys(userId, deviceId, body.fallback_keys);
    }

    const counts = await storage.getOneTimeKeyCounts(userId, deviceId);
    return { status: 200, body: { one_time_key_counts: counts } };
  };
}

// =============================================================================
// POST /_matrix/client/v3/keys/query
// =============================================================================

export function postKeysQuery(storage: Storage): Handler {
  return async (req) => {
    const body = (req.body ?? {}) as KeysQueryRequest;

    if (!body.device_keys) {
      throw badJson("Missing device_keys field");
    }

    const deviceKeys: Record<UserId, Record<DeviceId, DeviceKeys>> = {};

    for (const [targetUserId, deviceIds] of Object.entries(body.device_keys)) {
      if (deviceIds.length === 0) {
        // Empty array = return all devices
        const allKeys = await storage.getAllDeviceKeys(targetUserId as UserId);
        if (Object.keys(allKeys).length > 0) {
          deviceKeys[targetUserId as UserId] = allKeys;
        }
      } else {
        // Specific devices requested
        const userDeviceKeys: Record<DeviceId, DeviceKeys> = {};
        for (const did of deviceIds) {
          const keys = await storage.getDeviceKeys(targetUserId as UserId, did);
          if (keys) {
            userDeviceKeys[did] = keys;
          }
        }
        if (Object.keys(userDeviceKeys).length > 0) {
          deviceKeys[targetUserId as UserId] = userDeviceKeys;
        }
      }
    }

    return { status: 200, body: { device_keys: deviceKeys } };
  };
}

// =============================================================================
// POST /_matrix/client/v3/keys/claim
// =============================================================================

export function postKeysClaim(storage: Storage): Handler {
  return async (req) => {
    const body = (req.body ?? {}) as KeysClaimRequest;

    if (!body.one_time_keys) {
      throw badJson("Missing one_time_keys field");
    }

    const oneTimeKeys: Record<UserId, Record<DeviceId, Record<string, string | JsonObject>>> = {};

    for (const [targetUserId, devices] of Object.entries(body.one_time_keys)) {
      for (const [targetDeviceId, algorithm] of Object.entries(devices)) {
        const claimed = await storage.claimOneTimeKey(
          targetUserId as UserId,
          targetDeviceId as DeviceId,
          algorithm,
        );
        if (claimed) {
          if (!oneTimeKeys[targetUserId as UserId]) {
            oneTimeKeys[targetUserId as UserId] = {};
          }
          if (!oneTimeKeys[targetUserId as UserId]![targetDeviceId as DeviceId]) {
            oneTimeKeys[targetUserId as UserId]![targetDeviceId as DeviceId] = {};
          }
          oneTimeKeys[targetUserId as UserId]![targetDeviceId as DeviceId]![claimed.keyId] = claimed.key as string | JsonObject;
        }
      }
    }

    return { status: 200, body: { one_time_keys: oneTimeKeys } };
  };
}

// =============================================================================
// PUT /_matrix/client/v3/sendToDevice/:eventType/:txnId
// =============================================================================

export function putSendToDevice(storage: Storage): Handler {
  return async (req) => {
    const eventType = req.params["eventType"]!;
    const userId = req.userId!;
    const body = (req.body ?? {}) as { messages?: Record<UserId, Record<DeviceId, JsonObject>> };

    if (!body.messages) {
      throw badJson("Missing messages field");
    }

    for (const [targetUserId, devices] of Object.entries(body.messages)) {
      for (const [targetDeviceId, content] of Object.entries(devices)) {
        if (targetDeviceId === "*") {
          // Wildcard: send to all devices for this user
          const allDevices = await storage.getAllDevices(targetUserId as UserId);
          for (const device of allDevices) {
            await storage.sendToDevice(targetUserId as UserId, device.device_id, {
              type: eventType,
              sender: userId,
              content,
            });
          }
        } else {
          await storage.sendToDevice(targetUserId as UserId, targetDeviceId as DeviceId, {
            type: eventType,
            sender: userId,
            content,
          });
        }
      }
    }

    return { status: 200, body: {} };
  };
}

// =============================================================================
// GET /_matrix/client/v3/keys/changes
// =============================================================================

export function getKeysChanges(): Handler {
  return async () => {
    // Stub: no federation tracking yet, return empty lists
    return { status: 200, body: { changed: [], left: [] } };
  };
}
