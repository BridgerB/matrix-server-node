import type { Router } from "./router.ts";
import type { Storage } from "./storage/interface.ts";
import { requireAuth } from "./middleware/auth.ts";
import { versionsHandler, wellKnownServerHandler, wellKnownClientHandler } from "./handlers/discovery.ts";
import { getLoginFlows, postLogin } from "./handlers/login.ts";
import { postRegister } from "./handlers/register.ts";
import { postLogout, postLogoutAll } from "./handlers/logout.ts";
import { getWhoAmI, postChangePassword, postDeactivate } from "./handlers/account.ts";
import { postRefresh } from "./handlers/refresh.ts";
import { postCreateRoom, getJoinedRooms, postJoin, postLeave, postInvite, postKick, postBan, postUnban } from "./handlers/rooms.ts";
import { putSendEvent, putStateEvent, getAllState, getStateEvent, getMessages, getMembers, getEvent, postRedact } from "./handlers/room-events.ts";
import { getSync } from "./handlers/sync.ts";
import { getProfile, getDisplayName, getAvatarUrl, putDisplayName, putAvatarUrl } from "./handlers/profile.ts";
import { getDevices, getDevice, putDevice, deleteDevice, deleteDevices } from "./handlers/devices.ts";
import { getDirectoryRoom, putDirectoryRoom, deleteDirectoryRoom, getDirectoryListRoom, putDirectoryListRoom, getPublicRooms, postPublicRooms } from "./handlers/directory.ts";

export function registerRoutes(router: Router, storage: Storage, serverName: string): void {
  const auth = requireAuth(storage);

  // Discovery (public)
  router.get("/_matrix/client/versions", versionsHandler(serverName));
  router.get("/.well-known/matrix/server", wellKnownServerHandler(serverName));
  router.get("/.well-known/matrix/client", wellKnownClientHandler(serverName));

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

  // Redaction
  router.post("/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId", postRedact(storage, serverName), auth);

  // Sync
  router.get("/_matrix/client/v3/sync", getSync(storage, serverName), auth);
}
