import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { cors } from "./middleware/cors.ts";
import { Router } from "./router.ts";
import { registerRoutes } from "./routes.ts";
import { generateSigningKey, importSigningKey } from "./signing.ts";
import type { Storage } from "./storage/interface.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { MysqlStorage } from "./storage/mysql.ts";
import { PostgresStorage } from "./storage/postgres.ts";
import { SqliteStorage } from "./storage/sqlite.ts";

const PORT = parseInt(process.env.PORT ?? "8008", 10);
const SERVER_NAME = process.env.SERVER_NAME ?? "localhost";
const STORAGE_TYPE = process.env.STORAGE ?? "sqlite";
const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/matrix.db";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/matrix";

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

// Optional: TLS federation listener (for Complement / production federation)
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const FED_PORT = parseInt(process.env.FED_PORT ?? "8448", 10);

if (TLS_CERT && TLS_KEY) {
	const tlsServer = createTlsServer(
		{
			cert: readFileSync(TLS_CERT),
			key: readFileSync(TLS_KEY),
		},
		(req, res) => router.handle(req, res),
	);

	tlsServer.listen(FED_PORT, () => {
		console.log(`Federation TLS listening on :${FED_PORT}`);
	});
}
