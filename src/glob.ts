export const escapeGlob = (pattern: string): string =>
	pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");

export const globMatch = (
	pattern: string,
	value: string,
	caseInsensitive = false,
): boolean =>
	new RegExp(`^${escapeGlob(pattern)}$`, caseInsensitive ? "i" : "").test(
		value,
	);

export const globMatchWordBoundary = (pattern: string, body: string): boolean =>
	new RegExp(`(?:^|\\W)(${escapeGlob(pattern)})(?:$|\\W)`, "i").test(body);
