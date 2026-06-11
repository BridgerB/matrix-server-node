// Convert Complement's appservice registration YAML files into the JSON array
// our server reads from APPSERVICE_REGISTRATIONS. Complement copies each
// registration to /complement/appservice/<id>.yaml; the format it emits
// (internal/docker/builder.go) is a small, regular subset of YAML:
//
//   id: my-as
//   hs_token: <token>
//   as_token: <token>
//   url: http://...
//   sender_localpart: the-bridge-user
//   rate_limited: false
//   namespaces:
//     users:
//       - exclusive: false
//         regex: .*
//     aliases: []
//     rooms: []
//
// This is a deliberately minimal parser for exactly that shape (no general YAML
// support, zero dependencies). Run directly with Node's TypeScript stripping:
//   node scripts/complement-as-registrations.ts /complement/appservice
import fs from "node:fs";
import path from "node:path";

type Section = "ns" | "users" | "aliases" | "rooms";
type NamespaceEntry = Record<string, unknown>;
interface Registration {
	namespaces: {
		users: NamespaceEntry[];
		aliases: NamespaceEntry[];
		rooms: NamespaceEntry[];
	};
	[key: string]: unknown;
}

const dir = process.argv[2] || "/complement/appservice";

const stripQuotes = (s: string): string => {
	const t = s.trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	)
		return t.slice(1, -1);
	return t;
};

const coerce = (v: string): string | boolean => {
	if (v === "true") return true;
	if (v === "false") return false;
	return stripQuotes(v);
};

const applyKV = (obj: Record<string, unknown> | null, s: string): void => {
	const m = s.match(/^([a-z_]+):\s*(.*)$/i);
	if (m && obj) obj[m[1] as string] = coerce(m[2] as string);
};

const parseReg = (text: string): Registration => {
	const reg: Registration = {
		namespaces: { users: [], aliases: [], rooms: [] },
	};
	let section: Section | null = null;
	let cur: NamespaceEntry | null = null;
	for (const raw of text.split("\n")) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();

		if (indent === 0) {
			const m = line.match(/^([a-z_]+):\s*(.*)$/i);
			if (!m) continue;
			const [, key, val] = m as unknown as [string, string, string];
			if (key === "namespaces") {
				section = "ns";
				continue;
			}
			section = null;
			if (val !== "") reg[key] = coerce(val);
			continue;
		}

		if (section) {
			const nsKey = line.match(/^(users|aliases|rooms):\s*(.*)$/);
			if (nsKey && indent <= 2) {
				section = nsKey[1] as Section;
				continue;
			}
			if (line.startsWith("- ")) {
				cur = {};
				const bucket = reg.namespaces[section as "users" | "aliases" | "rooms"];
				if (Array.isArray(bucket)) bucket.push(cur);
				applyKV(cur, line.slice(2).trim());
			} else {
				applyKV(cur, line);
			}
		}
	}
	return reg;
};

const regs: Registration[] = [];
if (fs.existsSync(dir)) {
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
		regs.push(parseReg(fs.readFileSync(path.join(dir, f), "utf8")));
	}
}
process.stdout.write(JSON.stringify(regs));
