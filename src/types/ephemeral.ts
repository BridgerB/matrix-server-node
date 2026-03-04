// =============================================================================
// EVENT CONTENT TYPES - EPHEMERAL
// =============================================================================

import type { Timestamp, UserId } from "./identifiers.ts";

export interface TypingContent {
	user_ids: UserId[];
}

export interface ReceiptContent {
	[eventId: string]: {
		[receiptType: string]: {
			// "m.read", "m.read.private", "m.fully_read"
			[userId: string]: {
				ts: Timestamp;
				thread_id?: string;
			};
		};
	};
}

export type PresenceState = "online" | "offline" | "unavailable";

export interface PresenceContent {
	presence: PresenceState;
	status_msg?: string;
	currently_active?: boolean;
	last_active_ago?: number;
}
