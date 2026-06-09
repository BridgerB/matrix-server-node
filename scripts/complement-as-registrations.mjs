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
// support, zero dependencies).
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "/complement/appservice";

const stripQuotes = (s) => {
	const t = s.trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	)
		return t.slice(1, -1);
	return t;
};

const coerce = (v) => {
	if (v === "true") return true;
	if (v === "false") return false;
	return stripQuotes(v);
};

const applyKV = (obj, s) => {
	const m = s.match(/^([a-z_]+):\s*(.*)$/i);
	if (m && obj) obj[m[1]] = coerce(m[2]);
};

const parseReg = (text) => {
	const reg = { namespaces: { users: [], aliases: [], rooms: [] } };
	let section = null; // null | "ns" | "users" | "aliases" | "rooms"
	let cur = null;
	for (const raw of text.split("\n")) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();

		if (indent === 0) {
			const m = line.match(/^([a-z_]+):\s*(.*)$/i);
			if (!m) continue;
			const [, key, val] = m;
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
				section = nsKey[1];
				continue;
			}
			if (line.startsWith("- ")) {
				cur = {};
				if (Array.isArray(reg.namespaces[section]))
					reg.namespaces[section].push(cur);
				applyKV(cur, line.slice(2).trim());
			} else {
				applyKV(cur, line);
			}
		}
	}
	return reg;
};

const regs = [];
if (fs.existsSync(dir)) {
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
		regs.push(parseReg(fs.readFileSync(path.join(dir, f), "utf8")));
	}
}
process.stdout.write(JSON.stringify(regs));
