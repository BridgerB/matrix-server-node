import type { PresenceState } from "../types/ephemeral.ts";
import type { StrippedStateEvent } from "../types/events.ts";
import type { RoomId, RoomState, Timestamp, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const INVITE_STATE_TYPES = [
	"m.room.create",
	"m.room.join_rules",
	"m.room.canonical_alias",
	"m.room.avatar",
	"m.room.name",
	"m.room.encryption",
	"m.room.member",
] as const;

export const eventToStrippedState = (event: {
	content: JsonObject;
	sender: string;
	state_key?: string;
	type: string;
}): StrippedStateEvent => {
	// MSC4311: the m.room.create event is special-cased into stripped state in
	// full (not reduced to the minimal 4 fields), so invitees can read the room
	// version / creators (incl. origin_server_ts) from the invite. Mirrors
	// synapse strip_event for msc4291 rooms.
	if (event.type === "m.room.create" && (event.state_key ?? "") === "") {
		return {
			...(event as Record<string, unknown>),
			state_key: event.state_key ?? "",
		} as StrippedStateEvent;
	}
	return {
		content: event.content,
		sender: event.sender,
		state_key: event.state_key ?? "",
		type: event.type,
	};
};

export abstract class EphemeralMixin {
	protected streamCounter = 0;
	protected filterCounter = 0;
	protected eventWaiters = new Set<() => void>();
	protected roomCache = new Map<RoomId, RoomState>();
	protected typingTimers = new Map<
		RoomId,
		Map<UserId, ReturnType<typeof setTimeout>>
	>();
	/** Stream position at which each room's typing set last changed. Lets
	 * incremental /sync surface a room when typing changed (incl. to empty)
	 * since the `since` token, without re-reporting unchanged rooms. */
	protected typingChangedAt = new Map<RoomId, number>();
	protected presenceMap = new Map<
		UserId,
		{ presence: PresenceState; status_msg?: string; last_active_ts?: Timestamp }
	>();

	protected wakeWaiters(): void {
		for (const waiter of this.eventWaiters) waiter();
	}

	async waitForEvents(since: number, timeoutMs: number): Promise<void> {
		if (this.streamCounter > since) return;
		if (timeoutMs <= 0) return;

		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.eventWaiters.delete(wake);
				resolve();
			}, timeoutMs);

			const wake = () => {
				clearTimeout(timer);
				this.eventWaiters.delete(wake);
				resolve();
			};

			this.eventWaiters.add(wake);
		});
	}

	async setTyping(
		roomId: RoomId,
		userId: UserId,
		typing: boolean,
		timeout?: number,
	): Promise<void> {
		let roomTyping = this.typingTimers.get(roomId);
		if (!roomTyping) {
			roomTyping = new Map();
			this.typingTimers.set(roomId, roomTyping);
		}

		const wasTyping = roomTyping.has(userId);
		const existing = roomTyping.get(userId);
		if (existing) {
			clearTimeout(existing);
			roomTyping.delete(userId);
		}

		if (typing) {
			const ms = Math.min(timeout ?? 30000, 120000);
			const timer = setTimeout(() => {
				roomTyping?.delete(userId);
				this.typingChangedAt.set(roomId, ++this.streamCounter);
				this.wakeWaiters();
			}, ms);
			roomTyping.set(userId, timer);
		}

		// The typing set changed iff the user's typing membership flipped.
		if (wasTyping !== typing) {
			this.typingChangedAt.set(roomId, ++this.streamCounter);
		}
		this.wakeWaiters();
	}

	async getTypingUsers(roomId: RoomId): Promise<UserId[]> {
		const roomTyping = this.typingTimers.get(roomId);
		if (!roomTyping) return [];
		return [...roomTyping.keys()];
	}

	/** Stream position at which `roomId`'s typing set last changed (0 if never). */
	async getTypingChangedAt(roomId: RoomId): Promise<number> {
		return this.typingChangedAt.get(roomId) ?? 0;
	}

	async setPresence(
		userId: UserId,
		presence: PresenceState,
		statusMsg?: string,
	): Promise<void> {
		this.presenceMap.set(userId, {
			presence,
			status_msg: statusMsg,
			last_active_ts: Date.now(),
		});
		this.wakeWaiters();
	}

	async getPresence(userId: UserId): Promise<
		| {
				presence: PresenceState;
				status_msg?: string;
				last_active_ts?: Timestamp;
		  }
		| undefined
	> {
		return this.presenceMap.get(userId);
	}
}
