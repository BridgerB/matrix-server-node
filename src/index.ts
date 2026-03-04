import { createServer } from "node:http";
import { Router } from "./router.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { SqliteStorage } from "./storage/sqlite.ts";
import { PostgresStorage } from "./storage/postgres.ts";
import { MysqlStorage } from "./storage/mysql.ts";
import { cors } from "./middleware/cors.ts";
import { registerRoutes } from "./routes.ts";
import { generateSigningKey, importSigningKey } from "./signing.ts";
import type { Storage } from "./storage/interface.ts";

const PORT = parseInt(process.env.PORT ?? "8008", 10);
const SERVER_NAME = process.env.SERVER_NAME ?? "localhost";
const STORAGE_TYPE = process.env.STORAGE ?? "sqlite";
const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/matrix.db";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/matrix";

// Generate or load signing key for federation
const KEY_SEED = process.env.SIGNING_KEY_SEED;
const signingKey = KEY_SEED
	? importSigningKey(
			process.env.SIGNING_KEY_ID ?? "ed25519:auto",
			Buffer.from(KEY_SEED, "base64"),
		)
	: generateSigningKey(SERVER_NAME);

if (!KEY_SEED) {
	console.log(`Generated signing key ${signingKey.keyId}`);
	console.log(
		`Seed (set SIGNING_KEY_SEED to persist): ${signingKey.seed.toString("base64")}`,
	);
}

let storage: Storage;
if (STORAGE_TYPE === "memory") {
	console.log("Using in-memory storage");
	storage = new MemoryStorage();
} else if (STORAGE_TYPE === "sqlite") {
	console.log(`Using SQLite storage at ${DATABASE_PATH}`);
	storage = new SqliteStorage(DATABASE_PATH);
} else if (STORAGE_TYPE === "postgres") {
	console.log(`Using PostgreSQL storage at ${DATABASE_URL}`);
	storage = await PostgresStorage.create(DATABASE_URL);
} else if (STORAGE_TYPE === "mysql") {
	console.log(`Using MySQL/MariaDB storage at ${DATABASE_URL}`);
	storage = await MysqlStorage.create(DATABASE_URL);
} else {
	console.log(`Unknown storage type: ${STORAGE_TYPE}, falling back to SQLite`);
	storage = new SqliteStorage(DATABASE_PATH);
}
const router = new Router();

router.use(cors);
registerRoutes(router, storage, SERVER_NAME, signingKey);

const server = createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
	console.log(
		`matrix-server-node listening on :${PORT} (server_name: ${SERVER_NAME})`,
	);
});
