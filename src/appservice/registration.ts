import type { AppserviceRegistration } from "../types/appservice.ts";

/**
 * Load appservice registrations from the APPSERVICE_REGISTRATIONS environment
 * variable. The value must be a JSON array of registration objects.
 *
 * Returns an empty array when the variable is unset or empty.
 */
export const parseRegistrations = (
	envValue?: string,
): AppserviceRegistration[] => {
	const raw = envValue ?? process.env.APPSERVICE_REGISTRATIONS;
	if (!raw) return [];

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			console.error(
				"APPSERVICE_REGISTRATIONS must be a JSON array of registration objects",
			);
			return [];
		}
		return parsed as AppserviceRegistration[];
	} catch {
		console.error("Failed to parse APPSERVICE_REGISTRATIONS as JSON");
		return [];
	}
};

/**
 * Find the appservice whose user namespace matches the given user ID.
 */
export const findAppserviceForUser = (
	userId: string,
	registrations: AppserviceRegistration[],
): AppserviceRegistration | undefined =>
	registrations.find((reg) =>
		reg.namespaces.users?.some((ns) => new RegExp(ns.regex).test(userId)),
	);

/**
 * Find the appservice whose alias namespace matches the given room alias.
 */
export const findAppserviceForAlias = (
	alias: string,
	registrations: AppserviceRegistration[],
): AppserviceRegistration | undefined =>
	registrations.find((reg) =>
		reg.namespaces.aliases?.some((ns) => new RegExp(ns.regex).test(alias)),
	);

/**
 * Find the appservice that owns the given as_token.
 */
export const findAppserviceByToken = (
	asToken: string,
	registrations: AppserviceRegistration[],
): AppserviceRegistration | undefined =>
	registrations.find((reg) => reg.as_token === asToken);

/**
 * Check whether a user ID falls within an exclusive namespace of any
 * appservice. Returns the owning appservice if so.
 */
export const findExclusiveAppserviceForUser = (
	userId: string,
	registrations: AppserviceRegistration[],
): AppserviceRegistration | undefined =>
	registrations.find((reg) =>
		reg.namespaces.users?.some(
			(ns) => ns.exclusive && new RegExp(ns.regex).test(userId),
		),
	);
