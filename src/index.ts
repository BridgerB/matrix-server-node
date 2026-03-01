import { createServer } from "node:http";
import { Router } from "./router.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { cors } from "./middleware/cors.ts";
import { registerRoutes } from "./routes.ts";

const PORT = parseInt(process.env.PORT ?? "8008", 10);
const SERVER_NAME = process.env.SERVER_NAME ?? "localhost";

const storage = new MemoryStorage();
const router = new Router();

router.use(cors);
registerRoutes(router, storage, SERVER_NAME);

const server = createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
  console.log(`matrix-server-node listening on :${PORT} (server_name: ${SERVER_NAME})`);
});
