import type { WellKnown } from "./discovery.ts";
import type {
	AccessToken,
	DeviceId,
	MxcUri,
	RefreshToken,
	UserId,
} from "./identifiers.ts";
import type { JsonObject } from "./json.ts";

export type LoginType =
	| "m.login.password"
	| "m.login.token"
	| "m.login.sso"
	| "m.login.application_service"
	| "m.oauth";

export type AuthType =
	| "m.login.password"
	| "m.login.recaptcha"
	| "m.login.oauth2"
	| "m.login.email.identity"
	| "m.login.msisdn"
	| "m.login.dummy"
	| "m.login.registration_token"
	| "m.login.terms";

export interface LoginFlow {
	type: LoginType;
	identity_providers?: IdentityProvider[]; // for SSO
}

export interface IdentityProvider {
	id: string;
	name: string;
	icon?: MxcUri;
	brand?: string;
}

export interface LoginRequest {
	type: LoginType;
	identifier?: UserIdentifier;
	password?: string;
	token?: string;
	device_id?: DeviceId;
	initial_device_display_name?: string;
	refresh_token?: boolean;
}

export type UserIdentifier =
	| { type: "m.id.user"; user: string }
	| { type: "m.id.thirdparty"; medium: string; address: string }
	| { type: "m.id.phone"; country: string; phone: string };

export interface LoginResponse {
	user_id: UserId;
	access_token: AccessToken;
	device_id: DeviceId;
	well_known?: WellKnown;
	expires_in_ms?: number;
	refresh_token?: RefreshToken;
}

export interface RegisterRequest {
	auth?: AuthenticationData;
	username?: string;
	password?: string;
	device_id?: DeviceId;
	initial_device_display_name?: string;
	inhibit_login?: boolean;
	refresh_token?: boolean;
}

export interface AuthenticationData {
	type: AuthType;
	session?: string;
	// type-specific fields
	password?: string;
	token?: string;
	response?: string; // recaptcha
	threepid_creds?: ThreepidCreds;
	threepidCreds?: ThreepidCreds; // legacy
}

export interface ThreepidCreds {
	sid: string;
	client_secret: string;
	id_server?: string;
	id_access_token?: string;
}

/** User-Interactive Authentication API response */
export interface UIAAResponse {
	flows: { stages: AuthType[] }[];
	params: Record<string, JsonObject>;
	session: string;
	completed?: AuthType[];
	error?: string;
	errcode?: string;
}
