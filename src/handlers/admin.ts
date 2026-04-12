import { forbidden, notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { UserId } from "../types/index.ts";

/** In-memory locked status for user accounts */
const lockedUsers = new Map<UserId, boolean>();

/** In-memory suspended status for user accounts */
const suspendedUsers = new Map<UserId, { suspended: boolean; reason?: string }>();

export const putAdminLock =
	(storage: Storage): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;

		// Only allow self-locking since we don't have admin roles
		if (req.userId !== targetUserId)
			throw forbidden("Only server admins can lock other users");

		const user = await storage.getUserById(targetUserId);
		if (!user) throw notFound("User not found");

		const body = (req.body ?? {}) as { locked?: boolean };
		const locked = body.locked ?? false;
		lockedUsers.set(targetUserId, locked);

		return { status: 200, body: {} };
	};

export const getAdminLock =
	(storage: Storage): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;

		if (req.userId !== targetUserId)
			throw forbidden("Only server admins can view lock status");

		const user = await storage.getUserById(targetUserId);
		if (!user) throw notFound("User not found");

		const locked = lockedUsers.get(targetUserId) ?? false;
		return { status: 200, body: { locked } };
	};

export const putAdminSuspend =
	(storage: Storage): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;

		if (req.userId !== targetUserId)
			throw forbidden("Only server admins can suspend other users");

		const user = await storage.getUserById(targetUserId);
		if (!user) throw notFound("User not found");

		const body = (req.body ?? {}) as { suspended?: boolean; reason?: string };
		const suspended = body.suspended ?? false;
		suspendedUsers.set(targetUserId, { suspended, reason: body.reason });

		return { status: 200, body: {} };
	};

export const getAdminSuspend =
	(storage: Storage): Handler =>
	async (req) => {
		const targetUserId = req.params.userId as UserId;

		if (req.userId !== targetUserId)
			throw forbidden("Only server admins can view suspend status");

		const user = await storage.getUserById(targetUserId);
		if (!user) throw notFound("User not found");

		const entry = suspendedUsers.get(targetUserId);
		const suspended = entry?.suspended ?? false;
		return { status: 200, body: { suspended } };
	};
