import { FederationClient } from "./federation/client.ts";
import {
	getWhoAmI,
	postChangePassword,
	postDeactivate,
} from "./handlers/account.ts";
import {
	deleteTag,
	getGlobalAccountData,
	getRoomAccountData,
	getTags,
	putGlobalAccountData,
	putRoomAccountData,
	putTag,
} from "./handlers/account-data.ts";
import {
	deleteDevice,
	deleteDevices,
	getDevice,
	getDevices,
	putDevice,
} from "./handlers/devices.ts";
import {
	deleteDirectoryRoom,
	getDirectoryListRoom,
	getDirectoryRoom,
	getPublicRooms,
	getRoomAliases,
	postPublicRooms,
	putDirectoryListRoom,
	putDirectoryRoom,
} from "./handlers/directory.ts";
import {
	getCapabilities,
	versionsHandler,
	wellKnownClientHandler,
	wellKnownServerHandler,
	wellKnownSupportHandler,
} from "./handlers/discovery.ts";
import {
	getKeysChanges,
	postKeysClaim,
	postKeysQuery,
	postKeysUpload,
	putSendToDevice,
} from "./handlers/e2ee.ts";
import {
	postFederationKeysClaim,
	postFederationKeysQuery,
	postFederationUserDevices,
} from "./handlers/federation/devices.ts";
import {
	getFederationEvent,
	getFederationEventAuth,
	getFederationRoomState,
	getFederationRoomStateIds,
	postFederationBackfill,
	postFederationMissingEvents,
} from "./handlers/federation/events.ts";
import { getServerKeys } from "./handlers/federation/keys.ts";
import {
	getMakeJoin,
	getMakeLeave,
	putFederationInvite,
	putSendJoin,
	putSendLeave,
} from "./handlers/federation/membership.ts";
import {
	getFederationPublicRooms,
	getQueryDirectory,
	getQueryProfile,
} from "./handlers/federation/query.ts";
import { putFederationSend } from "./handlers/federation/transactions.ts";
import { getFilterById, postCreateFilter } from "./handlers/filters.ts";
import { getLoginFlows, postLogin } from "./handlers/login.ts";
import { postLogout, postLogoutAll } from "./handlers/logout.ts";
import {
	getConfig,
	getDownload,
	getThumbnail,
	postUpload,
} from "./handlers/media.ts";
import { getNotifications } from "./handlers/notifications.ts";
import { postOpenIdToken } from "./handlers/openid.ts";
import { getPresence, putPresence } from "./handlers/presence.ts";
import {
	getAvatarUrl,
	getDisplayName,
	getProfile,
	putAvatarUrl,
	putDisplayName,
} from "./handlers/profile.ts";
import {
	deletePushRule,
	getAllPushRules,
	getGlobalPushRules,
	getPushRule,
	getPushRuleActions,
	getPushRuleEnabled,
	getPushRulesByKind,
	putPushRule,
	putPushRuleActions,
	putPushRuleEnabled,
} from "./handlers/push-rules.ts";
import { getPushers, postPushersSet } from "./handlers/pushers.ts";
import { postReceipt } from "./handlers/receipts.ts";
import { postRefresh } from "./handlers/refresh.ts";
import { postRegister } from "./handlers/register.ts";
import { getRelations } from "./handlers/relations.ts";
import { postReportEvent } from "./handlers/report.ts";
import {
	getAllState,
	getContext,
	getEvent,
	getJoinedMembers,
	getMembers,
	getMessages,
	getStateEvent,
	getTimestampToEvent,
	postRedact,
	putSendEvent,
	putStateEvent,
} from "./handlers/room-events.ts";
import { postRoomUpgrade } from "./handlers/room-upgrade.ts";
import {
	getJoinedRooms,
	postBan,
	postCreateRoom,
	postForget,
	postInvite,
	postJoin,
	postKick,
	postLeave,
	postUnban,
} from "./handlers/rooms.ts";
import { postSearch } from "./handlers/search.ts";
import { getSpaceHierarchy } from "./handlers/spaces.ts";
import { getSync } from "./handlers/sync.ts";
import { getThreads } from "./handlers/threads.ts";
import {
	getThreePids,
	postAddThreePid,
	postDeleteThreePid,
} from "./handlers/threepid.ts";
import { putTyping } from "./handlers/typing.ts";
import { postUserDirectorySearch } from "./handlers/user-directory.ts";
import { getTurnServer } from "./handlers/voip.ts";
import { requireAuth } from "./middleware/auth.ts";
import { requireFederationAuth } from "./middleware/federation-auth.ts";
import type { Router } from "./router.ts";
import type { SigningKey } from "./signing.ts";
import type { Storage } from "./storage/interface.ts";
import type { ServerName } from "./types/index.ts";

export const registerRoutes = (
	router: Router,
	storage: Storage,
	serverName: string,
	signingKey?: SigningKey,
): void => {
	const auth = requireAuth(storage);

	router.get("/_matrix/client/versions", versionsHandler(serverName));
	router.get("/.well-known/matrix/server", wellKnownServerHandler(serverName));
	router.get("/.well-known/matrix/client", wellKnownClientHandler(serverName));
	router.get("/.well-known/matrix/support", wellKnownSupportHandler());
	router.get("/_matrix/client/v3/capabilities", getCapabilities(), auth);

	router.get("/_matrix/client/v3/login", getLoginFlows());
	router.post("/_matrix/client/v3/login", postLogin(storage, serverName));
	router.post("/_matrix/client/v3/register", postRegister(storage, serverName));
	router.post("/_matrix/client/v3/refresh", postRefresh(storage));

	router.post("/_matrix/client/v3/logout", postLogout(storage), auth);
	router.post("/_matrix/client/v3/logout/all", postLogoutAll(storage), auth);
	router.get("/_matrix/client/v3/account/whoami", getWhoAmI(), auth);

	router.post(
		"/_matrix/client/v3/account/password",
		postChangePassword(storage),
		auth,
	);
	router.post(
		"/_matrix/client/v3/account/deactivate",
		postDeactivate(storage),
		auth,
	);

	router.get("/_matrix/client/v3/profile/:userId", getProfile(storage));
	router.get(
		"/_matrix/client/v3/profile/:userId/displayname",
		getDisplayName(storage),
	);
	router.get(
		"/_matrix/client/v3/profile/:userId/avatar_url",
		getAvatarUrl(storage),
	);
	router.put(
		"/_matrix/client/v3/profile/:userId/displayname",
		putDisplayName(storage, serverName),
		auth,
	);
	router.put(
		"/_matrix/client/v3/profile/:userId/avatar_url",
		putAvatarUrl(storage, serverName),
		auth,
	);

	router.get("/_matrix/client/v3/devices", getDevices(storage), auth);
	router.get("/_matrix/client/v3/devices/:deviceId", getDevice(storage), auth);
	router.put("/_matrix/client/v3/devices/:deviceId", putDevice(storage), auth);
	router.delete(
		"/_matrix/client/v3/devices/:deviceId",
		deleteDevice(storage),
		auth,
	);
	router.post(
		"/_matrix/client/v3/delete_devices",
		deleteDevices(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/directory/room/:roomAlias",
		getDirectoryRoom(storage),
	);
	router.put(
		"/_matrix/client/v3/directory/room/:roomAlias",
		putDirectoryRoom(storage, serverName),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/directory/room/:roomAlias",
		deleteDirectoryRoom(storage, serverName),
		auth,
	);
	router.get(
		"/_matrix/client/v3/directory/list/room/:roomId",
		getDirectoryListRoom(storage),
	);
	router.put(
		"/_matrix/client/v3/directory/list/room/:roomId",
		putDirectoryListRoom(storage),
		auth,
	);
	router.get("/_matrix/client/v3/publicRooms", getPublicRooms(storage));
	router.post("/_matrix/client/v3/publicRooms", postPublicRooms(storage), auth);

	router.post(
		"/_matrix/client/v3/createRoom",
		postCreateRoom(storage, serverName),
		auth,
	);
	router.get("/_matrix/client/v3/joined_rooms", getJoinedRooms(storage), auth);

	router.post(
		"/_matrix/client/v3/join/:roomIdOrAlias",
		postJoin(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/join",
		postJoin(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/leave",
		postLeave(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/invite",
		postInvite(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/kick",
		postKick(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/ban",
		postBan(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/unban",
		postUnban(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/rooms/:roomId/forget",
		postForget(storage),
		auth,
	);

	router.put(
		"/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId",
		putSendEvent(storage, serverName),
		auth,
	);
	router.put(
		"/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey",
		putStateEvent(storage, serverName),
		auth,
	);
	router.put(
		"/_matrix/client/v3/rooms/:roomId/state/:eventType",
		putStateEvent(storage, serverName),
		auth,
	);

	router.get(
		"/_matrix/client/v3/rooms/:roomId/state",
		getAllState(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey",
		getStateEvent(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/state/:eventType",
		getStateEvent(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/messages",
		getMessages(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/members",
		getMembers(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/joined_members",
		getJoinedMembers(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/aliases",
		getRoomAliases(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/timestamp_to_event",
		getTimestampToEvent(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/event/:eventId",
		getEvent(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/context/:eventId",
		getContext(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId",
		postRedact(storage, serverName),
		auth,
	);

	router.get(
		"/_matrix/client/v3/rooms/:roomId/relations/:eventId/:relType/:eventType",
		getRelations(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/relations/:eventId/:relType",
		getRelations(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/rooms/:roomId/relations/:eventId",
		getRelations(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/user/:userId/filter",
		postCreateFilter(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/user/:userId/filter/:filterId",
		getFilterById(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/user/:userId/account_data/:type",
		getGlobalAccountData(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/user/:userId/account_data/:type",
		putGlobalAccountData(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type",
		getRoomAccountData(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type",
		putRoomAccountData(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/user/:userId/rooms/:roomId/tags",
		getTags(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/user/:userId/rooms/:roomId/tags/:tag",
		putTag(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/user/:userId/rooms/:roomId/tags/:tag",
		deleteTag(storage),
		auth,
	);

	router.put(
		"/_matrix/client/v3/rooms/:roomId/typing/:userId",
		putTyping(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/rooms/:roomId/receipt/:receiptType/:eventId",
		postReceipt(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/presence/:userId/status",
		getPresence(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/presence/:userId/status",
		putPresence(storage),
		auth,
	);

	router.post(
		"/_matrix/media/v3/upload",
		postUpload(storage, serverName),
		auth,
	);
	router.get(
		"/_matrix/media/v3/download/:serverName/:mediaId",
		getDownload(storage),
	);
	router.get(
		"/_matrix/media/v3/download/:serverName/:mediaId/:fileName",
		getDownload(storage),
	);
	router.get(
		"/_matrix/media/v3/thumbnail/:serverName/:mediaId",
		getThumbnail(storage),
	);
	router.get("/_matrix/media/v3/config", getConfig(), auth);

	router.get(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled",
		getPushRuleEnabled(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId/enabled",
		putPushRuleEnabled(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId/actions",
		getPushRuleActions(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId/actions",
		putPushRuleActions(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId",
		getPushRule(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId",
		putPushRule(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/pushrules/global/:kind/:ruleId",
		deletePushRule(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/pushrules/global/:kind",
		getPushRulesByKind(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/pushrules/global",
		getGlobalPushRules(storage),
		auth,
	);
	router.get("/_matrix/client/v3/pushrules", getAllPushRules(storage), auth);

	router.get("/_matrix/client/v3/pushers", getPushers(storage), auth);
	router.post("/_matrix/client/v3/pushers/set", postPushersSet(storage), auth);

	router.post("/_matrix/client/v3/keys/upload", postKeysUpload(storage), auth);
	router.post("/_matrix/client/v3/keys/query", postKeysQuery(storage), auth);
	router.post("/_matrix/client/v3/keys/claim", postKeysClaim(storage), auth);
	router.get("/_matrix/client/v3/keys/changes", getKeysChanges(), auth);

	router.put(
		"/_matrix/client/v3/sendToDevice/:eventType/:txnId",
		putSendToDevice(storage),
		auth,
	);

	router.get("/_matrix/client/v3/voip/turnServer", getTurnServer(), auth);

	router.post(
		"/_matrix/client/v3/rooms/:roomId/report/:eventId",
		postReportEvent(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/user/:userId/openid/request_token",
		postOpenIdToken(storage, serverName),
		auth,
	);

	router.get("/_matrix/client/v3/account/3pid", getThreePids(storage), auth);
	router.post(
		"/_matrix/client/v3/account/3pid/add",
		postAddThreePid(storage),
		auth,
	);
	router.post(
		"/_matrix/client/v3/account/3pid/delete",
		postDeleteThreePid(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/user_directory/search",
		postUserDirectorySearch(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/rooms/:roomId/threads",
		getThreads(storage),
		auth,
	);

	router.get(
		"/_matrix/client/v3/notifications",
		getNotifications(storage),
		auth,
	);

	router.post("/_matrix/client/v3/search", postSearch(storage), auth);

	router.get(
		"/_matrix/client/v3/rooms/:roomId/hierarchy",
		getSpaceHierarchy(storage),
		auth,
	);

	router.post(
		"/_matrix/client/v3/rooms/:roomId/upgrade",
		postRoomUpgrade(storage, serverName),
		auth,
	);

	router.get(
		"/_matrix/client/v3/thirdparty/protocols",
		async () => ({ status: 200, body: {} }),
	);

	router.get("/_matrix/client/v3/sync", getSync(storage, serverName), auth);

	if (signingKey) {
		const federationClient = new FederationClient(
			serverName as ServerName,
			signingKey,
		);
		const fedAuth = requireFederationAuth(
			serverName,
			storage,
			federationClient,
		);

		router.get("/_matrix/key/v2/server", getServerKeys(serverName, signingKey));
		router.get(
			"/_matrix/key/v2/server/:keyId",
			getServerKeys(serverName, signingKey),
		);

		router.get(
			"/_matrix/federation/v1/query/profile",
			getQueryProfile(storage),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/query/directory",
			getQueryDirectory(storage),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/publicRooms",
			getFederationPublicRooms(storage),
			fedAuth,
		);

		router.get(
			"/_matrix/federation/v1/event/:eventId",
			getFederationEvent(storage, serverName),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/state/:roomId",
			getFederationRoomState(storage),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/state_ids/:roomId",
			getFederationRoomStateIds(storage),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/event_auth/:roomId/:eventId",
			getFederationEventAuth(storage),
			fedAuth,
		);
		router.post(
			"/_matrix/federation/v1/backfill/:roomId",
			postFederationBackfill(storage, serverName),
			fedAuth,
		);
		router.post(
			"/_matrix/federation/v1/get_missing_events/:roomId",
			postFederationMissingEvents(storage),
			fedAuth,
		);

		router.post(
			"/_matrix/federation/v1/user/devices/:userId",
			postFederationUserDevices(storage),
			fedAuth,
		);
		router.post(
			"/_matrix/federation/v1/user/keys/query",
			postFederationKeysQuery(storage),
			fedAuth,
		);
		router.post(
			"/_matrix/federation/v1/user/keys/claim",
			postFederationKeysClaim(storage),
			fedAuth,
		);

		router.put(
			"/_matrix/federation/v1/send/:txnId",
			putFederationSend(storage, serverName, signingKey, federationClient),
			fedAuth,
		);

		router.get(
			"/_matrix/federation/v1/make_join/:roomId/:userId",
			getMakeJoin(storage, serverName),
			fedAuth,
		);
		router.put(
			"/_matrix/federation/v2/send_join/:roomId/:eventId",
			putSendJoin(storage, serverName, signingKey, federationClient),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/make_leave/:roomId/:userId",
			getMakeLeave(storage, serverName),
			fedAuth,
		);
		router.put(
			"/_matrix/federation/v2/send_leave/:roomId/:eventId",
			putSendLeave(storage, serverName, signingKey, federationClient),
			fedAuth,
		);
		router.put(
			"/_matrix/federation/v2/invite/:roomId/:eventId",
			putFederationInvite(storage, serverName, signingKey, federationClient),
			fedAuth,
		);
	}
};
