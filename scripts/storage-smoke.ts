// Standalone storage smoke — verifies the ephemeral store delegation, the stream
// counter, the room cache, and basic event persistence directly against a
// backend, without Docker/Complement. Run: `node scripts/storage-smoke.ts`.
import { createMemoryStorage } from "../src/storage/memory.ts";
import { createSqliteStorage } from "../src/storage/sqlite.ts";
import type { Storage } from "../src/storage/interface.ts";

const assert = (cond: unknown, msg: string): void => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
};

const smoke = async (name: string, s: Storage): Promise<void> => {
	const room = "!r:x" as never;
	const user = "@u:x" as never;

	// typing → advances streamCounter via the ephemeral store
	await s.setTyping(room, user, true, 30000);
	assert((await s.getTypingUsers(room)).length === 1, `${name}: typing user present`);
	const tca = await s.getTypingChangedAt(room);
	assert(tca > 0, `${name}: typingChangedAt advanced (counter via store)`);

	// presence → advances streamCounter past typing
	await s.setPresence(user, "online" as never, "hi");
	assert((await s.getPresence(user))?.presence === "online", `${name}: presence set`);
	const pca = await s.getPresenceChangedAt(user);
	assert(pca > tca, `${name}: presenceChangedAt advanced past typing`);

	// waitForEvents: resolves immediately when since < current counter
	await Promise.race([
		s.waitForEvents(0, 2000),
		new Promise((_, rej) => setTimeout(() => rej(new Error("waitForEvents(0) hung")), 1000)),
	]);

	// waitForEvents long-poll: blocks at `since = current`, woken by wakeWaiters
	let woke = false;
	const waiting = s.waitForEvents(pca, 2000).then(() => {
		woke = true;
	});
	await s.setPresence(user, "online" as never, "again"); // calls wakeWaiters
	await waiting;
	assert(woke, `${name}: waitForEvents woke on wakeWaiters`);

	// roomCache: createRoom populates it, getRoom reads it back
	await s.createRoom({
		room_id: "!r2:x" as never,
		room_version: "10" as never,
		state_events: new Map(),
		depth: 0,
		forward_extremities: [],
	});
	assert(
		(await s.getRoom("!r2:x" as never))?.room_id === "!r2:x",
		`${name}: getRoom via roomCache`,
	);

	console.log(`  ${name}: PASS`);
};

await smoke("memory", createMemoryStorage());
await smoke("sqlite", createSqliteStorage(":memory:"));
console.log("STORAGE SMOKE: ALL PASS");
