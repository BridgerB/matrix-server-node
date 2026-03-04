// =============================================================================
// APPSERVICE TYPES
// =============================================================================

import type { UserId } from "./identifiers.ts";
import type { ClientEvent, ToDeviceEvent } from "./events.ts";
import type { DeviceLists } from "./sync.ts";

export interface AppserviceRegistration {
	id: string;
	url: string;
	as_token: string;
	hs_token: string;
	sender_localpart: string;
	namespaces: {
		users?: AppserviceNamespace[];
		rooms?: AppserviceNamespace[];
		aliases?: AppserviceNamespace[];
	};
	rate_limited?: boolean;
	protocols?: string[];
}

export interface AppserviceNamespace {
	exclusive: boolean;
	regex: string;
}

export interface AppserviceTransaction {
	events: ClientEvent[];
	ephemeral?: ClientEvent[];
	to_device?: ToDeviceEvent[];
	device_lists?: DeviceLists;
	device_one_time_keys_count?: Record<UserId, Record<string, number>>;
	device_unused_fallback_key_types?: Record<UserId, string[]>;
}
