import { notFound } from "../errors.ts";
import type { Handler } from "../router.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";

export const getProtocols =
	(registrations: AppserviceRegistration[] = []): Handler =>
	(_req) => {
		const result: Record<
			string,
			{
				user_fields: string[];
				location_fields: string[];
				icon: string;
				field_types: Record<string, unknown>;
				instances: unknown[];
			}
		> = {};

		for (const reg of registrations) {
			if (reg.protocols) {
				for (const proto of reg.protocols) {
					if (!result[proto]) {
						result[proto] = {
							user_fields: [],
							location_fields: [],
							icon: "",
							field_types: {},
							instances: [],
						};
					}
				}
			}
		}

		return { status: 200, body: result };
	};

export const getProtocol =
	(registrations: AppserviceRegistration[] = []): Handler =>
	(req) => {
		const protocol = req.params.protocol!;

		for (const reg of registrations) {
			if (reg.protocols?.includes(protocol)) {
				return {
					status: 200,
					body: {
						user_fields: [],
						location_fields: [],
						icon: "",
						field_types: {},
						instances: [],
					},
				};
			}
		}

		throw notFound("Protocol not found");
	};

export const getThirdpartyLocation =
	(_registrations: AppserviceRegistration[] = []): Handler =>
	(_req) => {
		return { status: 200, body: [] };
	};

export const getThirdpartyLocationByProtocol =
	(_registrations: AppserviceRegistration[] = []): Handler =>
	(_req) => {
		return { status: 200, body: [] };
	};

export const getThirdpartyUser =
	(_registrations: AppserviceRegistration[] = []): Handler =>
	(_req) => {
		return { status: 200, body: [] };
	};

export const getThirdpartyUserByProtocol =
	(_registrations: AppserviceRegistration[] = []): Handler =>
	(_req) => {
		return { status: 200, body: [] };
	};
