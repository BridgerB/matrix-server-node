import type { PresenceState } from "../types/ephemeral.ts";
import type { RoomId, RoomState, Timestamp, UserId } from "../types/index.ts";

export const INVITE_STATE_TYPES = [
	"m.room.create",
	"m.room.join_rules",
	"m.room.canonical_alias",
	"m.room.avatar",
	"m.room.name",
	"m.room.encryption",
	"m.room.member",
] as const;

export abstract class EphemeralMixin {
	protected streamCounter = 0;
	protected filterCounter = 0;
	protected eventWaiters = new Set<() => void>();
	protected roomCache = new Map<RoomId, RoomState>();
	protected typingTimers = new Map<
		RoomId,
		Map<UserId, ReturnType<typeof setTimeout>>
	>();
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

		const existing = roomTyping.get(userId);
		if (existing) {
			clearTimeout(existing);
			roomTyping.delete(userId);
		}

		if (typing) {
			const ms = Math.min(timeout ?? 30000, 120000);
			const timer = setTimeout(() => {
				roomTyping?.delete(userId);
				this.wakeWaiters();
			}, ms);
			roomTyping.set(userId, timer);
		}

		this.wakeWaiters();
	}

	async getTypingUsers(roomId: RoomId): Promise<UserId[]> {
		const roomTyping = this.typingTimers.get(roomId);
		if (!roomTyping) return [];
		return [...roomTyping.keys()];
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
