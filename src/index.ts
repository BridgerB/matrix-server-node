import { createServer } from "node:http";
import { Router } from "./router.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { cors } from "./middleware/cors.ts";
import { registerRoutes } from "./routes.ts";
import { generateSigningKey, importSigningKey } from "./signing.ts";

const PORT = parseInt(process.env.PORT ?? "8008", 10);
const SERVER_NAME = process.env.SERVER_NAME ?? "localhost";

// Generate or load signing key for federation
const KEY_SEED = process.env.SIGNING_KEY_SEED;
const signingKey = KEY_SEED
  ? importSigningKey(process.env.SIGNING_KEY_ID ?? "ed25519:auto", Buffer.from(KEY_SEED, "base64"))
  : generateSigningKey(SERVER_NAME);

if (!KEY_SEED) {
  console.log(`Generated signing key ${signingKey.keyId}`);
  console.log(`Seed (set SIGNING_KEY_SEED to persist): ${signingKey.seed.toString("base64")}`);
}

const storage = new MemoryStorage();
const router = new Router();

router.use(cors);
registerRoutes(router, storage, SERVER_NAME, signingKey);

const server = createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
  console.log(`matrix-server-node listening on :${PORT} (server_name: ${SERVER_NAME})`);
});
