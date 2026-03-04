import type { Base64, DeviceId, Timestamp } from "./identifiers.ts";

export interface KeyVerificationRequestContent {
	from_device: DeviceId;
	methods: string[];
	timestamp: Timestamp;
	transaction_id?: string;
}

export interface KeyVerificationStartContent {
	from_device: DeviceId;
	method: string;
	transaction_id?: string;
	key_agreement_protocols?: string[];
	hashes?: string[];
	message_authentication_codes?: string[];
	short_authentication_string?: string[];
}

export interface KeyVerificationKeyContent {
	key: Base64;
	transaction_id?: string;
}

export interface KeyVerificationMacContent {
	keys: string;
	mac: Record<string, Base64>;
	transaction_id?: string;
}

export interface KeyVerificationDoneContent {
	transaction_id?: string;
}

export interface KeyVerificationCancelContent {
	code: string;
	reason: string;
	transaction_id?: string;
}
