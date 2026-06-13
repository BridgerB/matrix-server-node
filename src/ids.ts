/**
 * The server-name (domain) part of a Matrix identifier — everything after the
 * first colon. Works for user IDs (`@alice:example.com`), room IDs
 * (`!abc:example.com`), aliases, and so on, and keeps any port the server name
 * carries (`@alice:example.com:8448` → `example.com:8448`). An identifier with
 * no colon yields the empty string.
 */
export const domainOf = (id: string): string => {
	const idx = id.indexOf(":");
	return idx === -1 ? "" : id.slice(idx + 1);
};
