import type { Router } from "./router.ts";
import type { Storage } from "./storage/interface.ts";
import { requireAuth } from "./middleware/auth.ts";
import { versionsHandler, wellKnownServerHandler, wellKnownClientHandler } from "./handlers/discovery.ts";
import { getLoginFlows, postLogin } from "./handlers/login.ts";
import { postRegister } from "./handlers/register.ts";
import { postLogout, postLogoutAll } from "./handlers/logout.ts";
import { getWhoAmI } from "./handlers/account.ts";
import { postRefresh } from "./handlers/refresh.ts";

export function registerRoutes(router: Router, storage: Storage, serverName: string): void {
  const auth = requireAuth(storage);

  // Discovery (public)
  router.get("/_matrix/client/versions", versionsHandler(serverName));
  router.get("/.well-known/matrix/server", wellKnownServerHandler(serverName));
  router.get("/.well-known/matrix/client", wellKnownClientHandler(serverName));

  // Auth (public)
  router.get("/_matrix/client/v3/login", getLoginFlows());
  router.post("/_matrix/client/v3/login", postLogin(storage, serverName));
  router.post("/_matrix/client/v3/register", postRegister(storage, serverName));
  router.post("/_matrix/client/v3/refresh", postRefresh(storage));

  // Auth (authenticated)
  router.post("/_matrix/client/v3/logout", postLogout(storage), auth);
  router.post("/_matrix/client/v3/logout/all", postLogoutAll(storage), auth);
  router.get("/_matrix/client/v3/account/whoami", getWhoAmI(), auth);
}
