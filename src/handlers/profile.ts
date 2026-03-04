import { badJson, forbidden, notFound } from "../errors.ts";
import { buildEvent, checkEventAuth, selectAuthEvents } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

const MAX_DISPLAYNAME_BYTES = 256;
const MAX_AVATAR_URL_BYTES = 1000;

const propagateProfileToRooms = async (
	storage: Storage,
	serverName: string,
	userId: UserId,
): Promise<void> => {
	const profile = await storage.getProfile(userId);
	const rooms = await storage.getRoomsForUser(userId);

	for (const roomId of rooms) {
		const room = await storage.getRoom(roomId);
		if (!room) continue;

		const currentMember = room.state_events.get(`m.room.member\0${userId}`);
		if (!currentMember) continue;

		const currentContent = currentMember.content as Record<string, unknown>;
		if (currentContent.membership !== "join") continue;

		const newContent: JsonObject = { membership: "join" };
		if (profile?.displayname) newContent.displayname = profile.displayname;
		if (profile?.avatar_url) newContent.avatar_url = profile.avatar_url;

		const authEvents = selectAuthEvents("m.room.member", userId, room, userId);

		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: "m.room.member",
			content: newContent,
			stateKey: userId,
			depth: room.depth + 1,
			prevEvents: room.forward_extremities,
			authEvents,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.setStateEvent(roomId, event, eventId);
		room.depth += 1;
		room.forward_extremities = [eventId];
	}
};

export const getProfile =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		const profile = await storage.getProfile(userId);
		if (!profile) throw notFound("User not found");
		return { status: 200, body: profile };
	};

export const getDisplayName =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		const profile = await storage.getProfile(userId);
		if (!profile) throw notFound("User not found");
		return { status: 200, body: { displayname: profile.displayname ?? null } };
	};

export const getAvatarUrl =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		const profile = await storage.getProfile(userId);
		if (!profile) throw notFound("User not found");
		return { status: 200, body: { avatar_url: profile.avatar_url ?? null } };
	};

export const putDisplayName =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;
		if (req.userId !== targetUserId)
			throw forbidden("Cannot set displayname for another user");

		const body = req.body as Record<string, unknown>;
		const displayname = body.displayname as string | undefined;

		if (displayname !== undefined && displayname !== null) {
			if (Buffer.byteLength(displayname, "utf-8") > MAX_DISPLAYNAME_BYTES)
				throw badJson(`Displayname exceeds ${MAX_DISPLAYNAME_BYTES} bytes`);
		}

		await storage.setDisplayName(targetUserId, displayname ?? null);
		await propagateProfileToRooms(storage, serverName, targetUserId);
		return { status: 200, body: {} };
	};

export const putAvatarUrl =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;
		if (req.userId !== targetUserId)
			throw forbidden("Cannot set avatar_url for another user");

		const body = req.body as Record<string, unknown>;
		const avatarUrl = body.avatar_url as string | undefined;

		if (avatarUrl !== undefined && avatarUrl !== null) {
			if (Buffer.byteLength(avatarUrl, "utf-8") > MAX_AVATAR_URL_BYTES)
				throw badJson(`Avatar URL exceeds ${MAX_AVATAR_URL_BYTES} bytes`);
		}

		await storage.setAvatarUrl(targetUserId, avatarUrl ?? null);
		await propagateProfileToRooms(storage, serverName, targetUserId);
		return { status: 200, body: {} };
	};
