import type { Router } from "./router.ts";
import type { Storage } from "./storage/interface.ts";
import { requireAuth } from "./middleware/auth.ts";
import { versionsHandler, wellKnownServerHandler, wellKnownClientHandler, getCapabilities } from "./handlers/discovery.ts";
import { getLoginFlows, postLogin } from "./handlers/login.ts";
import { postRegister } from "./handlers/register.ts";
import { postLogout, postLogoutAll } from "./handlers/logout.ts";
import { getWhoAmI, postChangePassword, postDeactivate } from "./handlers/account.ts";
import { postRefresh } from "./handlers/refresh.ts";
import { postCreateRoom, getJoinedRooms, postJoin, postLeave, postInvite, postKick, postBan, postUnban } from "./handlers/rooms.ts";
import { putSendEvent, putStateEvent, getAllState, getStateEvent, getMessages, getMembers, getEvent, postRedact, getContext } from "./handlers/room-events.ts";
import { postCreateFilter, getFilterById } from "./handlers/filters.ts";
import { getSync } from "./handlers/sync.ts";
import { getProfile, getDisplayName, getAvatarUrl, putDisplayName, putAvatarUrl } from "./handlers/profile.ts";
import { getDevices, getDevice, putDevice, deleteDevice, deleteDevices } from "./handlers/devices.ts";
import { getDirectoryRoom, putDirectoryRoom, deleteDirectoryRoom, getDirectoryListRoom, putDirectoryListRoom, getPublicRooms, postPublicRooms } from "./handlers/directory.ts";
import { getGlobalAccountData, putGlobalAccountData, getRoomAccountData, putRoomAccountData, getTags, putTag, deleteTag } from "./handlers/account-data.ts";
import { putTyping } from "./handlers/typing.ts";
import { postReceipt } from "./handlers/receipts.ts";
import { getPresence, putPresence } from "./handlers/presence.ts";
import { postUpload, getDownload, getThumbnail, getConfig } from "./handlers/media.ts";
import { postKeysUpload, postKeysQuery, postKeysClaim, putSendToDevice, getKeysChanges } from "./handlers/e2ee.ts";
import {
  getAllPushRules, getGlobalPushRules, getPushRulesByKind, getPushRule,
  putPushRule, deletePushRule,
  getPushRuleEnabled, putPushRuleEnabled,
  getPushRuleActions, putPushRuleActions,
} from "./handlers/push-rules.ts";
import { getPushers, postPushersSet } from "./handlers/pushers.ts";
import { getRelations } from "./handlers/relations.ts";

export function registerRoutes(router: Router, storage: Storage, serverName: string): void {
  const auth = requireAuth(storage);

  // Discovery (public + authenticated)
  router.get("/_matrix/client/versions", versionsHandler(serverName));
  router.get("/.well-known/matrix/server", wellKnownServerHandler(serverName));
  router.get("/.well-known/matrix/client", wellKnownClientHandler(serverName));
  router.get("/_matrix/client/v3/capabilities", getCapabilities(), auth);

  // Auth (public)
  router.get("/_matrix/client/v3/login", getLoginFlows());
  router.post("/_matrix/client/v3/login", postLogin(storage, serverName));
  router.post("/_matrix/client/v3/register", postRegister(storage, serverName));
  router.post("/_matrix/client/v3/refresh", postRefresh(storage));

  // Auth (authenticated)
  router.post("/_matrix/client/v3/logout", postLogout(storage), auth);
  router.post("/_matrix/client/v3/logout/all", postLogoutAll(storage), auth);
  router.get("/_matrix/client/v3/account/whoami", getWhoAmI(), auth);

  // Account management (authenticated)
  router.post("/_matrix/client/v3/account/password", postChangePassword(storage), auth);
  router.post("/_matrix/client/v3/account/deactivate", postDeactivate(storage), auth);

  // Profile (public GET, authenticated PUT)
  router.get("/_matrix/client/v3/profile/:userId", getProfile(storage));
  router.get("/_matrix/client/v3/profile/:userId/displayname", getDisplayName(storage));
  router.get("/_matrix/client/v3/profile/:userId/avatar_url", getAvatarUrl(storage));
  router.put("/_matrix/client/v3/profile/:userId/displayname", putDisplayName(storage, serverName), auth);
  router.put("/_matrix/client/v3/profile/:userId/avatar_url", putAvatarUrl(storage, serverName), auth);

  // Devices (authenticated)
  router.get("/_matrix/client/v3/devices", getDevices(storage), auth);
  router.get("/_matrix/client/v3/devices/:deviceId", getDevice(storage), auth);
  router.put("/_matrix/client/v3/devices/:deviceId", putDevice(storage), auth);
  router.delete("/_matrix/client/v3/devices/:deviceId", deleteDevice(storage), auth);
  router.post("/_matrix/client/v3/delete_devices", deleteDevices(storage), auth);

  // Directory (public GET, authenticated PUT/DELETE)
  router.get("/_matrix/client/v3/directory/room/:roomAlias", getDirectoryRoom(storage));
  router.put("/_matrix/client/v3/directory/room/:roomAlias", putDirectoryRoom(storage, serverName), auth);
  router.delete("/_matrix/client/v3/directory/room/:roomAlias", deleteDirectoryRoom(storage, serverName), auth);
  router.get("/_matrix/client/v3/directory/list/room/:roomId", getDirectoryListRoom(storage));
  router.put("/_matrix/client/v3/directory/list/room/:roomId", putDirectoryListRoom(storage), auth);
  router.get("/_matrix/client/v3/publicRooms", getPublicRooms(storage));
  router.post("/_matrix/client/v3/publicRooms", postPublicRooms(storage), auth);

  // Rooms
  router.post("/_matrix/client/v3/createRoom", postCreateRoom(storage, serverName), auth);
  router.get("/_matrix/client/v3/joined_rooms", getJoinedRooms(storage), auth);

  // Membership
  router.post("/_matrix/client/v3/join/:roomIdOrAlias", postJoin(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/join", postJoin(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/leave", postLeave(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/invite", postInvite(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/kick", postKick(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/ban", postBan(storage, serverName), auth);
  router.post("/_matrix/client/v3/rooms/:roomId/unban", postUnban(storage, serverName), auth);

  // Send events
  router.put("/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId", putSendEvent(storage, serverName), auth);
  router.put("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey", putStateEvent(storage, serverName), auth);
  router.put("/_matrix/client/v3/rooms/:roomId/state/:eventType", putStateEvent(storage, serverName), auth);

  // Read events
  router.get("/_matrix/client/v3/rooms/:roomId/state", getAllState(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey", getStateEvent(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/state/:eventType", getStateEvent(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/messages", getMessages(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/members", getMembers(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/event/:eventId", getEvent(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/context/:eventId", getContext(storage), auth);

  // Redaction
  router.post("/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId", postRedact(storage, serverName), auth);

  // Relations (more specific routes first)
  router.get("/_matrix/client/v3/rooms/:roomId/relations/:eventId/:relType/:eventType", getRelations(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/relations/:eventId/:relType", getRelations(storage), auth);
  router.get("/_matrix/client/v3/rooms/:roomId/relations/:eventId", getRelations(storage), auth);

  // Filters (authenticated)
  router.post("/_matrix/client/v3/user/:userId/filter", postCreateFilter(storage), auth);
  router.get("/_matrix/client/v3/user/:userId/filter/:filterId", getFilterById(storage), auth);

  // Account data (authenticated)
  router.get("/_matrix/client/v3/user/:userId/account_data/:type", getGlobalAccountData(storage), auth);
  router.put("/_matrix/client/v3/user/:userId/account_data/:type", putGlobalAccountData(storage), auth);
  router.get("/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type", getRoomAccountData(storage), auth);
  router.put("/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type", putRoomAccountData(storage), auth);

  // Tags (authenticated)
  router.get("/_matrix/client/v3/user/:userId/rooms/:roomId/tags", getTags(storage), auth);
  router.put("/_matrix/client/v3/user/:userId/rooms/:roomId/tags/:tag", putTag(storage), auth);
  router.delete("/_matrix/client/v3/user/:userId/rooms/:roomId/tags/:tag", deleteTag(storage), auth);

  // Typing (authenticated)
  router.put("/_matrix/client/v3/rooms/:roomId/typing/:userId", putTyping(storage), auth);

  // Receipts (authenticated)
  router.post("/_matrix/client/v3/rooms/:roomId/receipt/:receiptType/:eventId", postReceipt(storage), auth);

  // Presence (authenticated)
  router.get("/_matrix/client/v3/presence/:userId/status", getPresence(storage), auth);
  router.put("/_matrix/client/v3/presence/:userId/status", putPresence(storage), auth);

  // Media (upload authenticated, download/thumbnail public)
  router.post("/_matrix/media/v3/upload", postUpload(storage, serverName), auth);
  router.get("/_matrix/media/v3/download/:serverName/:mediaId", getDownload(storage));
  router.get("/_matrix/media/v3/download/:serverName/:mediaId/:fileName", getDownload(storage));
  router.get("/_matrix/media/v3/thumbnail/:serverName/:mediaId", getThumbnail(storage));
  router.get("/_matrix/media/v3/config", getConfig(), auth);

  // Push rules (authenticated) — more specific routes must come first
  router.get("/_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled", getPushRuleEnabled(storage), auth);
  router.put("/_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled", putPushRuleEnabled(storage), auth);
  router.get("/_matrix/client/v3/pushrules/global/:kind/:ruleId/actions", getPushRuleActions(storage), auth);
  router.put("/_matrix/client/v3/pushrules/global/:kind/:ruleId/actions", putPushRuleActions(storage), auth);
  router.get("/_matrix/client/v3/pushrules/global/:kind/:ruleId", getPushRule(storage), auth);
  router.put("/_matrix/client/v3/pushrules/global/:kind/:ruleId", putPushRule(storage), auth);
  router.delete("/_matrix/client/v3/pushrules/global/:kind/:ruleId", deletePushRule(storage), auth);
  router.get("/_matrix/client/v3/pushrules/global/:kind", getPushRulesByKind(storage), auth);
  router.get("/_matrix/client/v3/pushrules/global", getGlobalPushRules(storage), auth);
  router.get("/_matrix/client/v3/pushrules", getAllPushRules(storage), auth);

  // Pushers (authenticated)
  router.get("/_matrix/client/v3/pushers", getPushers(storage), auth);
  router.post("/_matrix/client/v3/pushers/set", postPushersSet(storage), auth);

  // E2EE - Key management (authenticated)
  router.post("/_matrix/client/v3/keys/upload", postKeysUpload(storage), auth);
  router.post("/_matrix/client/v3/keys/query", postKeysQuery(storage), auth);
  router.post("/_matrix/client/v3/keys/claim", postKeysClaim(storage), auth);
  router.get("/_matrix/client/v3/keys/changes", getKeysChanges(), auth);

  // To-device messaging (authenticated)
  router.put("/_matrix/client/v3/sendToDevice/:eventType/:txnId", putSendToDevice(storage), auth);

  // Sync
  router.get("/_matrix/client/v3/sync", getSync(storage, serverName), auth);
}
