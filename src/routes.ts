import { parseRegistrations } from "./appservice/registration.ts";
import { FederationClient } from "./federation/client.ts";
import {
	postAppservicePing,
	putAppserviceDirectoryListRoom,
} from "./handlers/appservice.ts";
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
	getFederationTimestampToEvent,
	postFederationBackfill,
	postFederationMissingEvents,
} from "./handlers/federation/events.ts";
import { getServerKeys } from "./handlers/federation/keys.ts";
import {
	getMakeJoin,
	getMakeKnock,
	getMakeLeave,
	putFederationInvite,
	putSendJoin,
	putSendKnock,
	putSendLeave,
} from "./handlers/federation/membership.ts";
import {
	getFederationOpenIdUserinfo,
	getFederationPublicRooms,
	getFederationVersion,
	getQueryDirectory,
	getQueryProfile,
	postFederationPublicRooms,
} from "./handlers/federation/query.ts";
import {
	getFederationMediaDownload,
	getFederationMediaThumbnail,
} from "./handlers/federation/media.ts";
import { postFederationHierarchy } from "./handlers/federation/spaces.ts";
import { putFederationSend } from "./handlers/federation/transactions.ts";
import {
	postDeviceSigningUpload,
	postSignaturesUpload,
} from "./handlers/cross-signing.ts";
import { getFilterById, postCreateFilter } from "./handlers/filters.ts";
import {
	deleteKeyBackupAll,
	deleteKeyBackupRoom,
	deleteKeyBackupSession,
	deleteKeyBackupVersion,
	getKeyBackupAll,
	getKeyBackupRoom,
	getKeyBackupSession,
	getKeyBackupVersion,
	postKeyBackupVersion,
	putKeyBackupAll,
	putKeyBackupRoom,
	putKeyBackupSession,
	putKeyBackupVersion,
} from "./handlers/key-backup.ts";
import { getLoginFlows, postLogin } from "./handlers/login.ts";
import {
	getSsoCallback,
	getSsoConfig,
	getSsoFallback,
	getSsoRedirect,
} from "./handlers/sso.ts";
import { postLogout, postLogoutAll } from "./handlers/logout.ts";
import {
	getConfig,
	getDownload,
	getThumbnail,
	postCreateMedia,
	postUpload,
	putAsyncUpload,
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
import { postReadMarkers } from "./handlers/read-markers.ts";
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
	postKnock,
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
import {
	getAdminWhois,
	getRegisterAvailable,
	getRegistrationTokenValidity,
	postAccount3pidEmailRequestToken,
	postAccount3pidMsisdnRequestToken,
	postKnock as postKnockByAlias,
	postLoginGetToken,
	postPasswordEmailRequestToken,
	postPasswordMsisdnRequestToken,
	postRegisterEmailRequestToken,
	postRegisterMsisdnRequestToken,
	postThreePidBind,
	postThreePidUnbind,
} from "./handlers/threepid-verify.ts";
import { putTyping } from "./handlers/typing.ts";
import { postUserDirectorySearch } from "./handlers/user-directory.ts";
import { getUrlPreview } from "./handlers/url-preview.ts";
import { getTurnServer } from "./handlers/voip.ts";
import { requireAppserviceAuth } from "./middleware/appservice-auth.ts";
import { requireAuth } from "./middleware/auth.ts";
import { requireFederationAuth } from "./middleware/federation-auth.ts";
import { rateLimit } from "./middleware/rate-limit.ts";
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
	const registrations = parseRegistrations();
	const auth = requireAuth(storage);
	const asAuth = requireAppserviceAuth(registrations, serverName);
	const loginRL = rateLimit("login");
	const registerRL = rateLimit("register");
	const defaultRL = rateLimit("default");

	router.get("/_matrix/client/versions", versionsHandler(serverName));
	router.get("/.well-known/matrix/server", wellKnownServerHandler(serverName));
	router.get("/.well-known/matrix/client", wellKnownClientHandler(serverName));
	router.get("/.well-known/matrix/support", wellKnownSupportHandler());
	router.get("/_matrix/client/v3/capabilities", getCapabilities(), auth);

	router.get("/_matrix/client/v3/login", getLoginFlows(registrations));
	router.post(
		"/_matrix/client/v3/login",
		postLogin(storage, serverName, registrations),
		loginRL,
	);
	router.post(
		"/_matrix/client/v3/register",
		postRegister(storage, serverName),
		registerRL,
	);
	router.get(
		"/_matrix/client/v3/register/available",
		getRegisterAvailable(storage),
	);
	router.post(
		"/_matrix/client/v3/register/email/requestToken",
		postRegisterEmailRequestToken(storage, serverName),
	);
	router.post(
		"/_matrix/client/v3/register/msisdn/requestToken",
		postRegisterMsisdnRequestToken(),
	);
	router.get(
		"/_matrix/client/v3/register/m.login.registration_token/validity",
		getRegistrationTokenValidity(),
	);
	router.post("/_matrix/client/v3/refresh", postRefresh(storage));
	router.post(
		"/_matrix/client/v1/login/get_token",
		postLoginGetToken(storage),
		auth,
	);

	// SSO routes (only registered when SSO is configured)
	const ssoConfig = getSsoConfig();
	if (ssoConfig) {
		router.get(
			"/_matrix/client/v3/login/sso/redirect/:idpId",
			getSsoRedirect(ssoConfig),
		);
		router.get(
			"/_matrix/client/v3/login/sso/redirect",
			getSsoRedirect(ssoConfig),
		);
		router.get(
			"/_matrix/client/v3/login/sso/callback",
			getSsoCallback(storage, serverName, ssoConfig),
		);
		router.get(
			"/_matrix/client/v3/auth/m.login.sso/fallback/web",
			getSsoFallback(ssoConfig),
		);
	}

	router.post("/_matrix/client/v3/logout", postLogout(storage), auth);
	router.post("/_matrix/client/v3/logout/all", postLogoutAll(storage), auth);
	router.get("/_matrix/client/v3/account/whoami", getWhoAmI(), auth);

	router.post(
		"/_matrix/client/v3/account/password",
		postChangePassword(storage),
		auth,
		defaultRL,
	);
	router.post(
		"/_matrix/client/v3/account/password/email/requestToken",
		postPasswordEmailRequestToken(storage, serverName),
	);
	router.post(
		"/_matrix/client/v3/account/password/msisdn/requestToken",
		postPasswordMsisdnRequestToken(),
	);
	router.post(
		"/_matrix/client/v3/account/deactivate",
		postDeactivate(storage),
		auth,
		defaultRL,
	);

	router.get(
		"/_matrix/client/v3/admin/whois/:userId",
		getAdminWhois(storage),
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
		"/_matrix/client/v3/rooms/:roomId/knock",
		postKnock(storage, serverName),
		auth,
	);
	router.post(
		"/_matrix/client/v3/knock/:roomIdOrAlias",
		postKnockByAlias(storage, serverName),
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

	router.post(
		"/_matrix/client/v3/rooms/:roomId/read_markers",
		postReadMarkers(storage),
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
		"/_matrix/media/v1/create",
		postCreateMedia(storage, serverName),
		auth,
	);
	router.put(
		"/_matrix/media/v3/upload/:serverName/:mediaId",
		putAsyncUpload(storage, serverName),
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

	// Authenticated media endpoints (spec v1.11+)
	router.get(
		"/_matrix/client/v1/media/download/:serverName/:mediaId/:fileName",
		getDownload(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v1/media/download/:serverName/:mediaId",
		getDownload(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v1/media/thumbnail/:serverName/:mediaId",
		getThumbnail(storage),
		auth,
	);
	router.get("/_matrix/client/v1/media/config", getConfig(), auth);

	router.get(
		"/_matrix/client/v1/media/preview_url",
		getUrlPreview(),
		auth,
	);
	router.get(
		"/_matrix/media/v3/preview_url",
		getUrlPreview(),
		auth,
	);

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
	router.get("/_matrix/client/v3/keys/changes", getKeysChanges(storage), auth);

	router.post(
		"/_matrix/client/v3/keys/device_signing/upload",
		postDeviceSigningUpload(storage),
		auth,
	);
	router.post(
		"/_matrix/client/v3/keys/signatures/upload",
		postSignaturesUpload(storage),
		auth,
	);

	// Key backup version management
	router.post(
		"/_matrix/client/v3/room_keys/version",
		postKeyBackupVersion(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/room_keys/version/:version",
		getKeyBackupVersion(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/room_keys/version/:version",
		putKeyBackupVersion(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/room_keys/version/:version",
		deleteKeyBackupVersion(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/room_keys/version",
		getKeyBackupVersion(storage),
		auth,
	);

	// Key backup data — specific routes first
	router.put(
		"/_matrix/client/v3/room_keys/keys/:roomId/:sessionId",
		putKeyBackupSession(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/room_keys/keys/:roomId/:sessionId",
		getKeyBackupSession(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/room_keys/keys/:roomId/:sessionId",
		deleteKeyBackupSession(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/room_keys/keys/:roomId",
		putKeyBackupRoom(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/room_keys/keys/:roomId",
		getKeyBackupRoom(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/room_keys/keys/:roomId",
		deleteKeyBackupRoom(storage),
		auth,
	);
	router.put(
		"/_matrix/client/v3/room_keys/keys",
		putKeyBackupAll(storage),
		auth,
	);
	router.get(
		"/_matrix/client/v3/room_keys/keys",
		getKeyBackupAll(storage),
		auth,
	);
	router.delete(
		"/_matrix/client/v3/room_keys/keys",
		deleteKeyBackupAll(storage),
		auth,
	);

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
		"/_matrix/client/v3/account/3pid/email/requestToken",
		postAccount3pidEmailRequestToken(storage, serverName),
	);
	router.post(
		"/_matrix/client/v3/account/3pid/msisdn/requestToken",
		postAccount3pidMsisdnRequestToken(),
	);
	router.post(
		"/_matrix/client/v3/account/3pid/bind",
		postThreePidBind(),
		auth,
	);
	router.post(
		"/_matrix/client/v3/account/3pid/unbind",
		postThreePidUnbind(),
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
		auth,
	);

	router.get("/_matrix/client/v3/sync", getSync(storage, serverName), auth);

	// Appservice endpoints
	router.post(
		"/_matrix/client/v1/appservice/:appserviceId/ping",
		postAppservicePing(registrations),
	);
	router.put(
		"/_matrix/client/v3/directory/list/appservice/:networkId/:roomId",
		putAppserviceDirectoryListRoom(storage, registrations),
		asAuth,
	);

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
			"/_matrix/federation/v1/version",
			getFederationVersion(),
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
		router.post(
			"/_matrix/federation/v1/publicRooms",
			postFederationPublicRooms(storage),
			fedAuth,
		);

		router.get(
			"/_matrix/federation/v1/openid/userinfo",
			getFederationOpenIdUserinfo(storage),
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

		router.get(
			"/_matrix/federation/v1/timestamp_to_event/:roomId",
			getFederationTimestampToEvent(storage),
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

		router.get(
			"/_matrix/federation/v1/make_knock/:roomId/:userId",
			getMakeKnock(storage, serverName),
			fedAuth,
		);
		router.put(
			"/_matrix/federation/v1/send_knock/:roomId/:eventId",
			putSendKnock(storage, serverName, signingKey, federationClient),
			fedAuth,
		);

		router.get(
			"/_matrix/federation/v1/hierarchy/:roomId",
			postFederationHierarchy(storage),
			fedAuth,
		);

		router.get(
			"/_matrix/federation/v1/media/download/:mediaId",
			getFederationMediaDownload(storage, serverName),
			fedAuth,
		);
		router.get(
			"/_matrix/federation/v1/media/thumbnail/:mediaId",
			getFederationMediaThumbnail(storage, serverName),
			fedAuth,
		);
	}
};
