/**
 * Parse a pagination `limit` query parameter, clamping it to [1, max] and
 * falling back to `defaultLimit` when absent or unparseable.
 */
export const parseLimit = (
	limitStr: string | null,
	defaultLimit: number,
	max = 100,
): number =>
	Math.min(Math.max(parseInt(limitStr ?? String(defaultLimit), 10), 1), max);
