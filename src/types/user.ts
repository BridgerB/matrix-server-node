// =============================================================================
// USER PROFILE, ACCOUNT & DEVICES
// =============================================================================

import type { UserId, DeviceId, MxcUri, Timestamp } from "./identifiers.ts";

export interface UserProfile {
	displayname?: string;
	avatar_url?: MxcUri;
}

export interface AccountThreepid {
	medium: "email" | "msisdn";
	address: string;
	validated_at: Timestamp;
	added_at: Timestamp;
}

export interface WhoAmIResponse {
	user_id: UserId;
	device_id?: DeviceId;
	is_guest?: boolean;
}

export interface Device {
	device_id: DeviceId;
	display_name?: string;
	last_seen_ip?: string;
	last_seen_ts?: Timestamp;
}
