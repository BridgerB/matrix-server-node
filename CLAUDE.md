# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Matrix homeserver implemented entirely in Node.js/TypeScript with **zero production dependencies**. Only Node built-in modules are used: `node:http`, `node:https`, `node:crypto`, `node:dns/promises`. The two devDependencies are `typescript` and `@types/node`.

The server currently implements ~73 Client-Server API endpoints and ~20 Federation (Server-Server) API endpoints. All storage is in-memory via `MemoryStorage`. See `TODO.md` for the comprehensive list of what remains for full upstream parity.

---

## Commands

```bash
npm run dev          # Start dev server with --watch (Node 24 native file watching)
npm run typecheck    # tsc --noEmit — the primary quality gate, must pass clean
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled dist/index.js
```

There are **no tests, no linter, no formatter** configured. TypeScript strict mode is the only quality check. Always run `npm run typecheck` after changes to verify.

### Testing with curl

The server runs on `http://localhost:8008` by default. Quick smoke test sequence:

```bash
# Start the server
npm run dev

# Register a user
curl -s -X POST http://localhost:8008/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123","auth":{"type":"m.login.dummy","session":"test"}}'

# Check federation key server
curl -s http://localhost:8008/_matrix/key/v2/server | jq .
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8008` | HTTP listen port |
| `SERVER_NAME` | `localhost` | Matrix server name (appears in user IDs like `@alice:localhost`) |
| `SIGNING_KEY_SEED` | *(auto-generated)* | Base64-encoded 32-byte ed25519 seed for federation signing key |
| `SIGNING_KEY_ID` | `ed25519:auto` | Key ID for the signing key (format: `ed25519:<tag>`) |

If `SIGNING_KEY_SEED` is not set, a new key is generated on every startup and the seed is printed to stdout for persistence.

---

## Project Architecture

### Startup Flow

`src/index.ts` is the entry point. It:
1. Reads env vars (`PORT`, `SERVER_NAME`, `SIGNING_KEY_SEED`)
2. Generates or imports an ed25519 signing key via `src/signing.ts`
3. Creates a `MemoryStorage` instance
4. Creates a `Router` instance
5. Registers the `cors` middleware globally via `router.use(cors)`
6. Calls `registerRoutes(router, storage, serverName, signingKey)` to wire up all ~100 endpoints
7. Starts a `node:http` server

### The Router (`src/router.ts`)

A custom HTTP router built on `node:http`. No Express, no Hono, no frameworks.

**Core types:**
```typescript
interface RouterRequest {
  raw: IncomingMessage;         // Original Node request
  method: string;               // GET, POST, PUT, DELETE
  path: string;                 // URL pathname
  params: Record<string, string>; // Path parameters (from :param segments)
  query: URLSearchParams;       // Query string
  headers: IncomingMessage["headers"];
  body: unknown;                // Parsed JSON body
  rawBody?: Buffer;             // Raw body (for media uploads)
  userId?: UserId;              // Set by auth middleware
  deviceId?: DeviceId;          // Set by auth middleware
  accessToken?: AccessToken;    // Set by auth middleware
  origin?: ServerName;          // Set by federation auth middleware
}

interface RouterResponse {
  status: number;
  body: unknown;                // JSON-serialized, or Buffer for binary
  headers?: Record<string, string>;
}

type Handler = (req: RouterRequest) => RouterResponse | Promise<RouterResponse>;
type Middleware = (req: RouterRequest, next: Handler) => RouterResponse | Promise<RouterResponse>;
```

**Route registration:** `router.get(pattern, handler, ...middleware)`. Path parameters use `:prefix` syntax, e.g. `/:roomId/event/:eventId`.

**Middleware composition:** Global middleware (registered via `router.use()`) runs first, then route-specific middleware passed as trailing args to `router.get/post/put/delete`. Middleware wraps from right to left (last middleware is innermost), executed left to right.

**Body parsing:** The router automatically parses JSON bodies for POST/PUT/PATCH/DELETE. For media endpoints (paths starting with `/_matrix/media/`), the raw buffer is preserved in `req.rawBody` instead. Non-JSON Content-Type on non-media endpoints returns `M_NOT_JSON`.

**Error handling:** If a handler throws a `MatrixError`, the router catches it and returns a JSON response with the appropriate status code and `{ errcode, error }` body. Any other thrown error becomes a 500 with `M_UNKNOWN`.

**Unmatched routes** still run global middleware (CORS), then return `404 M_UNRECOGNIZED`.

### Route Registration (`src/routes.ts`)

`registerRoutes(router, storage, serverName, signingKey?)` wires up all endpoints. The pattern is:

```typescript
const auth = requireAuth(storage);

// Public endpoint — no middleware
router.get("/_matrix/client/v3/login", getLoginFlows());

// Authenticated endpoint — auth middleware as trailing arg
router.put("/_matrix/client/v3/devices/:deviceId", putDevice(storage), auth);

// Federation endpoint — fedAuth middleware
router.get("/_matrix/federation/v1/query/profile", getQueryProfile(storage), fedAuth);
```

Federation endpoints are only registered when `signingKey` is provided (it always is in normal startup). They create a `FederationClient`, `RemoteKeyStore`, and `fedAuth` middleware:

```typescript
if (signingKey) {
  const federationClient = new FederationClient(serverName, signingKey);
  const remoteKeyStore = new RemoteKeyStore(storage);
  const fedAuth = requireFederationAuth(serverName, remoteKeyStore, federationClient);
  // ... register ~20 federation routes
}
```

**Route ordering matters.** More specific routes must come before less specific ones. For example, push rule routes go: `/global/:kind/:ruleId/enabled` before `/global/:kind/:ruleId` before `/global/:kind` before `/global`.

### Handler Factory Pattern

Every handler is a **factory function** that captures dependencies and returns a `Handler`:

```typescript
export function getProfile(storage: Storage): Handler {
  return async (req) => {
    const userId = req.params["userId"]!;
    const profile = await storage.getProfile(userId as UserId);
    if (!profile) throw notFound("User not found");
    return { status: 200, body: { displayname: profile.displayname, avatar_url: profile.avatar_url } };
  };
}
```

Common dependencies captured: `storage: Storage`, `serverName: string`. Federation handlers additionally capture `signingKey: SigningKey`, `remoteKeyStore: RemoteKeyStore`, `federationClient: FederationClient`.

Request data access patterns:
- **Path params:** `req.params["roomId"]!` (always use `!` — the router guarantees matched params exist)
- **Query params:** `req.query.get("limit")` (returns `string | null`)
- **Auth context:** `req.userId!`, `req.deviceId!` (guaranteed by auth middleware)
- **Federation origin:** `req.origin!` (guaranteed by fedAuth middleware)
- **Body:** `(req.body ?? {}) as SomeType` (always cast, may be undefined for empty bodies)
- **Raw body:** `req.rawBody` (only for media uploads)

### Error Handling (`src/errors.ts`)

`MatrixError` extends `Error` with `errcode`, `error`, `statusCode`, and optional `extra` fields. Use the convenience constructors:

```typescript
throw forbidden("User not allowed");              // M_FORBIDDEN, 403
throw notFound("Room not found");                  // M_NOT_FOUND, 404
throw badJson("Missing required field");           // M_BAD_JSON, 400
throw unknownToken("Token expired", true);         // M_UNKNOWN_TOKEN, 401, { soft_logout: true }
throw missingToken();                              // M_MISSING_TOKEN, 401
throw userInUse();                                 // M_USER_IN_USE, 400
throw invalidUsername("Bad chars");                // M_INVALID_USERNAME, 400
throw weakPassword("Too short");                   // M_WEAK_PASSWORD, 400
throw missingParam("Missing 'user_id'");           // M_MISSING_PARAM, 400
throw invalidParam("Bad value");                   // M_INVALID_PARAM, 400
throw roomNotFound();                              // M_NOT_FOUND, 404
throw notJoined();                                 // M_FORBIDDEN, 403
throw serverNotTrusted("Key fetch failed");        // M_SERVER_NOT_TRUSTED, 403
throw unableToAuthoriseJoin("Not public");         // M_UNABLE_TO_AUTHORISE_JOIN, 403
throw incompatibleRoomVersion("Unsupported");      // M_INCOMPATIBLE_ROOM_VERSION, 400
throw new MatrixError("M_TOO_LARGE", "Too big", 413);  // Custom error
```

`MatrixError.toJSON()` returns `{ errcode, error, ...extra }` — the router calls this automatically.

### Middleware

Three middleware modules:

**`src/middleware/cors.ts`** — Global middleware. Returns CORS headers on every response. Handles OPTIONS preflight. Allows all origins, GET/POST/PUT/DELETE/OPTIONS.

**`src/middleware/auth.ts`** — Route-specific. `requireAuth(storage)` returns a middleware that:
1. Extracts access token from `Authorization: Bearer <token>` header or `?access_token=` query param
2. Looks up session in storage
3. Sets `req.userId`, `req.deviceId`, `req.accessToken`
4. Fires-and-forgets a `touchSession()` call to update last-seen IP/user-agent
5. Throws `M_MISSING_TOKEN` (no token) or `M_UNKNOWN_TOKEN` (invalid token)

**`src/middleware/federation-auth.ts`** — Route-specific for federation endpoints. `requireFederationAuth(serverName, remoteKeyStore, federationClient)` returns a middleware that:
1. Parses `Authorization: X-Matrix origin="...",destination="...",key="...",sig="..."` header
2. Verifies `destination` matches our `serverName`
3. Fetches the origin server's public key via `RemoteKeyStore`
4. Reconstructs the signed JSON object: `{ method, uri, origin, destination, content? }`
5. Verifies the ed25519 signature via `verifyJsonSignature()`
6. Sets `req.origin` to the authenticated origin server name
7. Throws `M_FORBIDDEN` (bad sig) or `M_SERVER_NOT_TRUSTED` (can't fetch key)

---

## Storage Architecture

### Interface (`src/storage/interface.ts`)

The `Storage` interface defines ~60 async methods grouped by domain:

- **Users:** `createUser`, `getUserByLocalpart`, `getUserById`
- **Sessions/Devices:** `createSession`, `getSessionByAccessToken`, `getSessionByRefreshToken`, `deleteSession`, `deleteAllSessions`, `rotateToken`, `touchSession`
- **UIAA:** `createUIAASession`, `getUIAASession`, `addUIAACompleted`, `deleteUIAASession`
- **Rooms:** `createRoom`, `getRoom`, `getRoomsForUser`
- **Events:** `storeEvent`, `getEvent`, `getEventsByRoom`, `getStreamPosition`
- **State:** `getStateEvent`, `getAllState`, `setStateEvent`
- **Members:** `getMemberEvents`
- **Txn idempotency:** `getTxnEventId`, `setTxnEventId`
- **Sync:** `getRoomsForUserWithMembership`, `getEventsByRoomSince`, `getStrippedState`, `waitForEvents`
- **Profile:** `getProfile`, `setDisplayName`, `setAvatarUrl`
- **Devices:** `getDevice`, `getAllDevices`, `updateDeviceDisplayName`, `deleteDeviceSession`
- **Account:** `updatePassword`, `deactivateUser`
- **Aliases:** `createRoomAlias`, `deleteRoomAlias`, `getRoomByAlias`, `getAliasesForRoom`, `getAliasCreator`
- **Directory:** `setRoomVisibility`, `getRoomVisibility`, `getPublicRoomIds`
- **Account data:** `getGlobalAccountData`, `setGlobalAccountData`, `getAllGlobalAccountData`, `getRoomAccountData`, `setRoomAccountData`, `getAllRoomAccountData`
- **Typing:** `setTyping`, `getTypingUsers`
- **Receipts:** `setReceipt`, `getReceipts`
- **Presence:** `setPresence`, `getPresence`
- **Media:** `storeMedia`, `getMedia`
- **Filters:** `createFilter`, `getFilter`
- **E2EE:** `setDeviceKeys`, `getDeviceKeys`, `getAllDeviceKeys`, `addOneTimeKeys`, `claimOneTimeKey`, `getOneTimeKeyCounts`, `setFallbackKeys`, `getFallbackKeyTypes`
- **To-device:** `sendToDevice`, `getToDeviceMessages`, `clearToDeviceMessages`
- **Pushers:** `getPushers`, `setPusher`, `deletePusher`, `deletePusherByKey`
- **Relations:** `storeRelation`, `getRelatedEvents`, `getAnnotationCounts`, `getLatestEdit`, `getThreadSummary`
- **Reports:** `storeReport`
- **OpenID:** `storeOpenIdToken`, `getOpenIdToken`
- **3PIDs:** `getThreePids`, `addThreePid`, `deleteThreePid`
- **User directory:** `searchUserDirectory`
- **Threads:** `getThreadRoots`
- **Search:** `searchRoomEvents`
- **Federation keys:** `storeServerKeys`, `getServerKeys`
- **Federation auth chain:** `getAuthChain`, `getServersInRoom`, `getStateAtEvent`
- **Federation txn dedup:** `getFederationTxn`, `setFederationTxn`
- **Federation room import:** `importRoomState`

### Implementation (`src/storage/memory.ts`)

`MemoryStorage` implements `Storage` with TypeScript `Map`s and `Set`s. Key data structures:

```typescript
class MemoryStorage implements Storage {
  private users = new Map<string, UserAccount>();          // localpart → account
  private usersByFullId = new Map<UserId, UserAccount>();  // full user ID → account
  private sessions = new Map<AccessToken, StoredSession>();
  private rooms = new Map<RoomId, RoomState>();
  private events = new Map<EventId, PDU>();
  private roomTimeline = new Map<RoomId, { eventId: EventId; streamPos: number }[]>();
  private streamCounter = 0;                               // monotonic counter for sync tokens
  private aliases = new Map<RoomAlias, { room_id, servers, creator }>();
  private serverKeysCache = new Map<string, { key, validUntil }>();  // "server|keyId" → cached key
  private federationTxns = new Map<string, boolean>();      // "origin|txnId" → seen
  // ... 20+ more Maps for other domains
}
```

**Stream positions:** Every stored event gets a monotonically increasing `streamCounter`. Sync tokens are stringified integers (e.g., `"42"`). `waitForEvents(since, timeout)` uses a `Set` of resolve callbacks that are triggered whenever the counter advances, enabling long-poll sync.

**Room state:** `RoomState.state_events` is a `Map<string, PDU>` where the key is `type + "\0" + state_key`. For example: `"m.room.member\0@alice:localhost"`, `"m.room.name\0"`, `"m.room.create\0"`. When adding a new storage backend, this compound key format must be preserved or translated.

---

## Event System (`src/events.ts`)

This is the core of the server. All event creation, hashing, and auth checking lives here.

### Canonical JSON

```typescript
canonicalJson(val: unknown): string
```
Deterministic JSON serialization per the Matrix spec: sorted object keys, no whitespace, no trailing commas. Used for signing and hashing.

### Event Redaction

```typescript
redactEvent(event: PDU): PDU
```
Strips an event down to federation-safe fields. Keeps only: `auth_events`, `content` (filtered by event type), `depth`, `hashes`, `origin_server_ts`, `prev_events`, `room_id`, `sender`, `signatures`, `state_key`, `type`. Content is further filtered per event type (e.g., `m.room.member` keeps only `membership`, `join_authorised_via_users_server`, `third_party_invite`).

### Content Hash & Event ID

```typescript
computeContentHash(event: PDU): string     // base64url SHA256 of canonical JSON (minus unsigned/signatures/hashes)
computeEventId(event: PDU): EventId        // "$" + base64url SHA256 of redacted canonical JSON (room version 4+)
```

Event IDs are derived from the content. The process is: compute content hash → inject into `hashes.sha256` → redact → remove `unsigned`/`signatures` → canonical JSON → SHA256 → prepend `$`. This means event IDs are deterministic given the same content.

### Building Events

```typescript
buildEvent(params: {
  roomId, sender, type, content,
  stateKey?, depth, prevEvents, authEvents,
  redacts?, unsigned?, serverName,
  signingKey?                              // If provided, signs the event
}): { event: PDU; eventId: EventId }
```

Creates a PDU with proper `hashes`, computes the event ID. If `signingKey` is provided, also signs the event via `signEvent()`. This is the primary way to create new events throughout the codebase.

### Auth Event Selection

```typescript
selectAuthEvents(eventType, stateKey, roomState, sender): EventId[]
```

Picks which auth events to reference for a new event per the spec: always includes `m.room.create`, `m.room.power_levels`, and the sender's `m.room.member`. For membership events, also includes `m.room.join_rules` and the target user's `m.room.member`.

### Power Levels

```typescript
getPowerLevels(roomState): RoomPowerLevelsContent
getUserPowerLevel(userId, roomState): number
```

Before `m.room.power_levels` exists, the room creator has implicit PL 100 and everyone else has 0.

### Auth Checking

```typescript
checkEventAuth(event: PDU, eventId: EventId, roomState: RoomState): void  // throws on failure
getMembership(roomState, userId): string | undefined
```

`checkEventAuth` implements the Matrix event authorization rules:
- `m.room.create` is only allowed as the first event
- `m.room.member` has complex rules per membership type (join/invite/leave/ban/knock)
- All other events require sender to be joined and have sufficient power level

Membership auth rules (in `checkMembershipAuth`):
- **join:** Self-only. Allowed if: already joined (rejoin), invited (accepting), room creator (initial), or public join_rules. Banned users cannot join.
- **invite:** Sender must be joined with sufficient invite PL. Cannot invite banned users.
- **leave (self):** Must be joined or invited.
- **leave (kick):** Sender must be joined with kick PL, and higher PL than target.
- **ban:** Sender must be joined with ban PL, and higher PL than target (unless self-ban).

### PDU → Client Event

```typescript
pduToClientEvent(pdu: PDU, eventId: EventId): ClientEvent
```

Converts a federation PDU to the client-facing event format (adds `event_id`, removes federation fields like `auth_events`, `prev_events`, `depth`, `hashes`, `signatures`).

---

## Signing & Federation Crypto (`src/signing.ts`)

Ed25519 signing using `node:crypto` with DER prefix manipulation (no external crypto libraries).

### DER Encoding

Ed25519 keys in Node.js are wrapped in DER/ASN.1 containers. Raw 32-byte keys are extracted/injected using fixed prefixes:
```typescript
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // private key wrapper (16 bytes)
const SPKI_PREFIX  = Buffer.from("302a300506032b6570032100", "hex");        // public key wrapper (12 bytes)
```

To get the raw 32-byte seed: `privateKey.export({ type: "pkcs8", format: "der" }).subarray(16)`.
To get the raw 32-byte public key: `publicKey.export({ type: "spki", format: "der" }).subarray(12)`.

### Base64 Encoding

Matrix uses **unpadded standard base64** (`+` and `/`, no `=` padding) for signatures and keys. NOT base64url.

```typescript
unpaddedBase64(buf: Buffer): string           // buf.toString('base64').replace(/=+$/, '')
unpaddedBase64Decode(str: string): Buffer     // re-adds padding, then Buffer.from(..., 'base64')
```

Event IDs use **base64url** (via `digest('base64url')`). This is a different encoding.

### Key Generation & Import

```typescript
generateSigningKey(serverName): SigningKey      // generates new ed25519 keypair
importSigningKey(keyId, seed: Buffer): SigningKey  // reconstructs from 32-byte seed
```

`SigningKey` contains: `keyId` (e.g. `ed25519:Ab1Cde`), `privateKey`/`publicKey` (KeyObject), `publicKeyBase64` (unpadded base64 of raw 32-byte pubkey), `seed` (raw 32-byte seed for persistence).

Key IDs are generated as `ed25519:<first 6 chars of base64url-encoded pubkey>`.

### JSON Signing & Verification

```typescript
signJson(obj, serverName, key): Record<string, unknown>
```
1. Copy object, remove `signatures` and `unsigned`
2. `canonicalJson(copy)` → sign with ed25519
3. Insert signature into `obj.signatures[serverName][keyId]`

```typescript
verifyJsonSignature(obj, serverName, keyId, publicKeyBase64): boolean
```
1. Copy object, remove `signatures` and `unsigned`
2. `canonicalJson(copy)` → verify against the signature in `obj.signatures[serverName][keyId]`

### Event Signing & Verification

```typescript
signEvent(event, serverName, key): PDU
```
1. Compute content hash, inject into `hashes.sha256`
2. **Redact** the event (strip non-essential fields per spec)
3. Remove `unsigned` and `signatures` from redacted copy
4. `canonicalJson()` → sign → inject signature into original event's `signatures`

```typescript
verifyEventSignature(event, serverName, keyId, publicKeyBase64): boolean
```
Same process: redact → strip unsigned/signatures → canonical JSON → verify.

**Key insight:** Event signatures are over the **redacted** form, not the full event. This means events remain verifiable even after redaction.

---

## Federation System

### Server Discovery (`src/federation/discovery.ts`)

`resolveServer(serverName)` → `{ host, port, serverName }` with 5-minute caching:
1. If serverName has explicit port (e.g., `example.com:443`) → use directly
2. Fetch `https://<serverName>/.well-known/matrix/server` → parse `m.server` field
3. DNS SRV `_matrix-fed._tcp.<serverName>` via `node:dns/promises`
4. DNS SRV `_matrix._tcp.<serverName>` (legacy)
5. Fallback: `<serverName>:8448`

### Federation Client (`src/federation/client.ts`)

`FederationClient` makes outbound HTTPS requests to other Matrix servers:
```typescript
client.request(destination, method, path, body?) → { status, body }
```

Signs every request with `X-Matrix` Authorization header:
```
X-Matrix origin="our.server",destination="their.server",key="ed25519:abc",sig="<base64sig>"
```

The signed content is `{ method, uri, origin, destination, content? }` — signed via `signJson()`.

Uses `resolveServer()` for target host/port. `rejectUnauthorized: false` for dev (federation often uses self-signed certs). 30-second timeout.

**Important:** Uses explicit field declarations, NOT TypeScript parameter properties, because Node 24's type-stripping mode doesn't support `private` parameter properties.

### Remote Key Store (`src/federation/key-store.ts`)

`RemoteKeyStore` fetches and caches other servers' signing keys:
```typescript
store.getServerKey(serverName, keyId, client) → base64 public key | undefined
```

1. Check storage cache (respects `validUntil` expiry)
2. Fetch `GET /_matrix/key/v2/server` from the remote server
3. Verify the self-signature on the response
4. Cache in storage via `storeServerKeys()`

### Server ACL (`src/federation/acl.ts`)

```typescript
isServerAllowedByAcl(serverName, roomState): boolean
```

Checks `m.room.server_acl` state event. If no ACL event exists, all servers are allowed. Otherwise:
1. If `allow_ip_literals` is false, reject IP addresses
2. Check `deny` list (glob patterns — `*` matches any, `?` matches one char)
3. Check `allow` list
4. Default deny if allow list exists but no match

---

## Event Relations (`src/relations.ts`)

### Indexing

```typescript
indexRelation(storage, event, eventId): Promise<void>
```

After storing an event, call this to extract `m.relates_to` from content and store the relation. Used for reactions, edits, threads, and replies.

### Bundled Aggregations

```typescript
bundleAggregations(storage, events: ClientEvent[], userId): Promise<void>
```

Enriches client events with `unsigned["m.relations"]` containing:
- `m.annotation` — reaction counts grouped by `{ type, key, count }`
- `m.replace` — latest edit by original sender
- `m.thread` — thread summary with latest event, count, and participation status

Called by `/sync`, `/messages`, `/event/:eventId`, `/context/:eventId`, and `/relations`.

---

## Sync (`src/handlers/sync.ts`)

The `/sync` endpoint supports both initial sync (no `since` token) and incremental sync.

**Initial sync:** Returns all joined rooms with recent timeline (20 events), state, ephemeral (typing + receipts), presence, to-device messages, and E2EE key counts.

**Incremental sync:** Returns only changes since the `since` token. Computes room deltas (new events, membership changes), includes leave/invite transitions.

**Long-polling:** If `timeout` > 0 and `since` is provided, calls `storage.waitForEvents(since, timeout)` which blocks until new events arrive or timeout expires.

**Notification counts:** For each room, evaluates push rules against timeline events to compute `notification_count` and `highlight_count`.

**Sync tokens** are stringified integers representing the stream position: `"0"`, `"42"`, etc.

---

## Push Rules (`src/push-rules.ts`)

Full push rule evaluation engine:

```typescript
evaluatePushRules(rules: PushRulesContent, ctx: EvaluationContext): PushEvalResult
```

Evaluates rules in priority order: override → content → room → sender → underride. Supports conditions: `event_match` (glob on event fields), `contains_display_name`, `room_member_count`, `sender_notification_permission`, `event_property_is`, `event_property_contains`.

Default rules include: `.m.rule.master`, `.m.rule.suppress_notices`, `.m.rule.invite_for_me`, `.m.rule.is_user_mention`, `.m.rule.is_room_mention`, `.m.rule.tombstone`, `.m.rule.contains_display_name`, `.m.rule.call`, `.m.rule.encrypted_room_one_to_one`, `.m.rule.room_one_to_one`, `.m.rule.message`, `.m.rule.encrypted`.

Push rules are stored in global account data under `m.push_rules` and lazily initialized on first access via `getOrInitRules()`.

---

## State Resolution (`src/state-resolution.ts`)

Implements State Resolution v2 (room versions 2+):

```typescript
resolveState(stateAtForks: Map<string, PDU>[], authEvents: Map<EventId, PDU>, roomState: RoomState): Map<string, PDU>
```

Algorithm:
1. Find unconflicted state (all forks agree) and conflicted state
2. Partition conflicted into power events (`m.room.power_levels`, `m.room.join_rules`, `m.room.member`, `m.room.third_party_invite`) and other events
3. Sort power events by reverse topological power ordering: sender PL descending → `origin_server_ts` ascending → event ID lexicographic ascending
4. Iteratively apply power events: auth-check each against current resolved state, keep if it passes
5. Sort and iteratively apply other events the same way
6. Merge unconflicted + resolved power + resolved other

---

## Type System (`src/types/`)

30+ type definition files organized by domain, barrel-exported from `src/types/index.ts`.

### Identifiers (`src/types/identifiers.ts`)

All string type aliases with JSDoc examples:

| Type | Example | Format |
|------|---------|--------|
| `UserId` | `@alice:example.com` | `@localpart:server_name` |
| `RoomId` | `!abc123:example.com` | `!opaque:server_name` |
| `RoomAlias` | `#general:example.com` | `#localpart:server_name` |
| `EventId` | `$base64urlhash` | `$` + base64url SHA256 (v4+) |
| `DeviceId` | `ABCDEF` | Opaque string |
| `ServerName` | `example.com` or `example.com:8448` | hostname with optional port |
| `KeyId` | `ed25519:AABBCC` | `algorithm:identifier` |
| `MxcUri` | `mxc://example.com/abc` | `mxc://server/media_id` |
| `AccessToken` | *(opaque)* | Base64url random bytes |
| `RefreshToken` | *(opaque)* | Base64url random bytes |
| `Timestamp` | `1709251200000` | Unix milliseconds |

These are plain `string` (or `number`) aliases — they don't have branded type guards. Cast with `as UserId`, etc.

### Core Event Types (`src/types/events.ts`)

- **`PDU`** — Persistent Data Unit. The canonical event format used in federation and storage. Contains `auth_events`, `prev_events`, `depth`, `hashes`, `signatures`, etc.
- **`EDU`** — Ephemeral Data Unit. Non-persistent events for federation (typing, presence, receipts).
- **`ClientEvent`** — Event as returned to clients. Has `event_id`, no `auth_events`/`prev_events`/`depth`/`hashes`/`signatures`.
- **`StrippedStateEvent`** — Minimal state event for invites/knocks.
- **`ToDeviceEvent`** — Event sent directly to a device (E2EE key sharing, etc.).

### Internal Types (`src/types/internal.ts`)

- **`RoomState`** — `{ room_id, room_version, state_events: Map<string, PDU>, depth, forward_extremities }`
- **`UserAccount`** — `{ user_id, localpart, server_name, password_hash, account_type, is_deactivated, created_at, displayname?, avatar_url? }`
- **`DeviceSession`** — `{ device_id, user_id, access_token_hash, display_name?, last_seen_ip?, last_seen_ts?, user_agent? }`
- **`StoredMedia`** — `{ media_id, origin, user_id?, content_type, upload_name?, file_size, content_hash, created_at, quarantined }`

### Federation Types (`src/types/federation.ts`)

`FederationTransaction`, `ServerKeys`, `MakeJoinResponse`, `SendJoinResponse`, `MakeLeaveResponse`, `FederationInviteRequest`, `BackfillResponse`, `MissingEventsRequest/Response`, `StateResponse`, `EventAuthResponse`, `FederationDeviceListResponse`, `FederationKeyClaimResponse`, `FederationPublicRoomsResponse`, `FederationProfileResponse`.

### Other Notable Type Files

- `src/types/state-events.ts` — `RoomCreateContent`, `RoomMemberContent`, `RoomPowerLevelsContent`, `RoomJoinRulesContent`, etc.
- `src/types/sync.ts` — `SyncResponse`, `JoinedRoom`, `InvitedRoom`, `LeftRoom`
- `src/types/auth.ts` — `LoginRequest`, `LoginResponse`, `RegisterRequest`, `UIAAResponse`, `LoginFlow`
- `src/types/e2ee.ts` — `DeviceKeys`, `OneTimeKey`, `CrossSigningKey`, `KeysUploadRequest`, `KeysQueryRequest`, `KeysClaimRequest`
- `src/types/push.ts` — `PushRulesContent`, `PushRule`, `PushCondition`, `PushAction`, `Pusher`
- `src/types/room-versions.ts` — `RoomVersion` type
- `src/types/json.ts` — `JsonValue`, `JsonObject`

---

## Crypto Utilities (`src/crypto.ts`)

Simple random token generation using `node:crypto`:

```typescript
generateToken(): string      // 32 random bytes → base64url (for access/refresh tokens)
generateSessionId(): string  // 16 random bytes → base64url (for UIAA sessions)
generateDeviceId(): string   // 8 random bytes → base64url → uppercase (for device IDs)
generateRoomId(serverName): string  // "!" + 18 random bytes base64url + ":" + serverName
```

---

## All Endpoints

### Client-Server API (~73 endpoints)

**Discovery (public):**
- `GET /_matrix/client/versions`
- `GET /.well-known/matrix/server`
- `GET /.well-known/matrix/client`
- `GET /_matrix/client/v3/capabilities` (authenticated)

**Auth (public):**
- `GET /_matrix/client/v3/login`
- `POST /_matrix/client/v3/login`
- `POST /_matrix/client/v3/register`
- `POST /_matrix/client/v3/refresh`

**Auth (authenticated):**
- `POST /_matrix/client/v3/logout`
- `POST /_matrix/client/v3/logout/all`
- `GET /_matrix/client/v3/account/whoami`
- `POST /_matrix/client/v3/account/password`
- `POST /_matrix/client/v3/account/deactivate`

**Profile (public GET, authenticated PUT):**
- `GET/PUT /_matrix/client/v3/profile/:userId`
- `GET/PUT /_matrix/client/v3/profile/:userId/displayname`
- `GET/PUT /_matrix/client/v3/profile/:userId/avatar_url`

**Devices (authenticated):**
- `GET /_matrix/client/v3/devices`
- `GET/PUT/DELETE /_matrix/client/v3/devices/:deviceId`
- `POST /_matrix/client/v3/delete_devices`

**Directory (public GET, authenticated PUT/DELETE):**
- `GET/PUT/DELETE /_matrix/client/v3/directory/room/:roomAlias`
- `GET/PUT /_matrix/client/v3/directory/list/room/:roomId`
- `GET /_matrix/client/v3/publicRooms`
- `POST /_matrix/client/v3/publicRooms` (authenticated)

**Rooms (authenticated):**
- `POST /_matrix/client/v3/createRoom`
- `GET /_matrix/client/v3/joined_rooms`
- `POST /_matrix/client/v3/join/:roomIdOrAlias`
- `POST /_matrix/client/v3/rooms/:roomId/join`
- `POST /_matrix/client/v3/rooms/:roomId/leave`
- `POST /_matrix/client/v3/rooms/:roomId/invite`
- `POST /_matrix/client/v3/rooms/:roomId/kick`
- `POST /_matrix/client/v3/rooms/:roomId/ban`
- `POST /_matrix/client/v3/rooms/:roomId/unban`

**Events (authenticated):**
- `PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId`
- `PUT /_matrix/client/v3/rooms/:roomId/state/:eventType(/:stateKey)`
- `GET /_matrix/client/v3/rooms/:roomId/state`
- `GET /_matrix/client/v3/rooms/:roomId/state/:eventType(/:stateKey)`
- `GET /_matrix/client/v3/rooms/:roomId/messages`
- `GET /_matrix/client/v3/rooms/:roomId/members`
- `GET /_matrix/client/v3/rooms/:roomId/event/:eventId`
- `GET /_matrix/client/v3/rooms/:roomId/context/:eventId`
- `POST /_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId`

**Relations (authenticated):**
- `GET /_matrix/client/v3/rooms/:roomId/relations/:eventId(/:relType(/:eventType))`

**Filters (authenticated):**
- `POST /_matrix/client/v3/user/:userId/filter`
- `GET /_matrix/client/v3/user/:userId/filter/:filterId`

**Account Data (authenticated):**
- `GET/PUT /_matrix/client/v3/user/:userId/account_data/:type`
- `GET/PUT /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type`

**Tags (authenticated):**
- `GET /_matrix/client/v3/user/:userId/rooms/:roomId/tags`
- `PUT/DELETE /_matrix/client/v3/user/:userId/rooms/:roomId/tags/:tag`

**Ephemeral (authenticated):**
- `PUT /_matrix/client/v3/rooms/:roomId/typing/:userId`
- `POST /_matrix/client/v3/rooms/:roomId/receipt/:receiptType/:eventId`
- `GET/PUT /_matrix/client/v3/presence/:userId/status`

**Media (upload authenticated, download public):**
- `POST /_matrix/media/v3/upload`
- `GET /_matrix/media/v3/download/:serverName/:mediaId(/:fileName)`
- `GET /_matrix/media/v3/thumbnail/:serverName/:mediaId`
- `GET /_matrix/media/v3/config` (authenticated)

**Push (authenticated):**
- `GET /_matrix/client/v3/pushrules(/global(/:kind(/:ruleId(/enabled|/actions))))`
- `PUT /_matrix/client/v3/pushrules/global/:kind/:ruleId(/enabled|/actions)`
- `DELETE /_matrix/client/v3/pushrules/global/:kind/:ruleId`
- `GET /_matrix/client/v3/pushers`
- `POST /_matrix/client/v3/pushers/set`

**E2EE (authenticated):**
- `POST /_matrix/client/v3/keys/upload`
- `POST /_matrix/client/v3/keys/query`
- `POST /_matrix/client/v3/keys/claim`
- `GET /_matrix/client/v3/keys/changes`
- `PUT /_matrix/client/v3/sendToDevice/:eventType/:txnId`

**Other (authenticated):**
- `GET /_matrix/client/v3/voip/turnServer`
- `POST /_matrix/client/v3/rooms/:roomId/report/:eventId`
- `POST /_matrix/client/v3/user/:userId/openid/request_token`
- `GET /_matrix/client/v3/account/3pid`
- `POST /_matrix/client/v3/account/3pid/add`
- `POST /_matrix/client/v3/account/3pid/delete`
- `POST /_matrix/client/v3/user_directory/search`
- `GET /_matrix/client/v3/rooms/:roomId/threads`
- `GET /_matrix/client/v3/notifications`
- `POST /_matrix/client/v3/search`
- `GET /_matrix/client/v3/rooms/:roomId/hierarchy`
- `POST /_matrix/client/v3/rooms/:roomId/upgrade`
- `GET /_matrix/client/v3/sync`

### Federation API (~20 endpoints)

**Key server (public):**
- `GET /_matrix/key/v2/server(/:keyId)`

**Queries (federation-authenticated):**
- `GET /_matrix/federation/v1/query/profile`
- `GET /_matrix/federation/v1/query/directory`
- `GET /_matrix/federation/v1/publicRooms`

**Events (federation-authenticated):**
- `GET /_matrix/federation/v1/event/:eventId`
- `GET /_matrix/federation/v1/state/:roomId`
- `GET /_matrix/federation/v1/state_ids/:roomId`
- `GET /_matrix/federation/v1/event_auth/:roomId/:eventId`
- `POST /_matrix/federation/v1/backfill/:roomId`
- `POST /_matrix/federation/v1/get_missing_events/:roomId`

**Devices (federation-authenticated):**
- `POST /_matrix/federation/v1/user/devices/:userId`
- `POST /_matrix/federation/v1/user/keys/query`
- `POST /_matrix/federation/v1/user/keys/claim`

**Transactions (federation-authenticated):**
- `PUT /_matrix/federation/v1/send/:txnId`

**Membership (federation-authenticated):**
- `GET /_matrix/federation/v1/make_join/:roomId/:userId`
- `PUT /_matrix/federation/v2/send_join/:roomId/:eventId`
- `GET /_matrix/federation/v1/make_leave/:roomId/:userId`
- `PUT /_matrix/federation/v2/send_leave/:roomId/:eventId`
- `PUT /_matrix/federation/v2/invite/:roomId/:eventId`

---

## Handler Files Reference

| File | Handlers |
|------|----------|
| `src/handlers/discovery.ts` | `versionsHandler`, `wellKnownServerHandler`, `wellKnownClientHandler`, `getCapabilities` |
| `src/handlers/login.ts` | `getLoginFlows`, `postLogin` |
| `src/handlers/register.ts` | `postRegister` |
| `src/handlers/logout.ts` | `postLogout`, `postLogoutAll` |
| `src/handlers/refresh.ts` | `postRefresh` |
| `src/handlers/account.ts` | `getWhoAmI`, `postChangePassword`, `postDeactivate` |
| `src/handlers/profile.ts` | `getProfile`, `getDisplayName`, `getAvatarUrl`, `putDisplayName`, `putAvatarUrl` |
| `src/handlers/devices.ts` | `getDevices`, `getDevice`, `putDevice`, `deleteDevice`, `deleteDevices` |
| `src/handlers/rooms.ts` | `postCreateRoom`, `getJoinedRooms`, `postJoin`, `postLeave`, `postInvite`, `postKick`, `postBan`, `postUnban` |
| `src/handlers/room-events.ts` | `putSendEvent`, `putStateEvent`, `getAllState`, `getStateEvent`, `getMessages`, `getMembers`, `getEvent`, `postRedact`, `getContext` |
| `src/handlers/directory.ts` | `getDirectoryRoom`, `putDirectoryRoom`, `deleteDirectoryRoom`, `getDirectoryListRoom`, `putDirectoryListRoom`, `getPublicRooms`, `postPublicRooms` |
| `src/handlers/account-data.ts` | `getGlobalAccountData`, `putGlobalAccountData`, `getRoomAccountData`, `putRoomAccountData`, `getTags`, `putTag`, `deleteTag` |
| `src/handlers/typing.ts` | `putTyping` |
| `src/handlers/receipts.ts` | `postReceipt` |
| `src/handlers/presence.ts` | `getPresence`, `putPresence` |
| `src/handlers/media.ts` | `postUpload`, `getDownload`, `getThumbnail`, `getConfig` |
| `src/handlers/filters.ts` | `postCreateFilter`, `getFilterById` |
| `src/handlers/sync.ts` | `getSync` |
| `src/handlers/e2ee.ts` | `postKeysUpload`, `postKeysQuery`, `postKeysClaim`, `putSendToDevice`, `getKeysChanges` |
| `src/handlers/push-rules.ts` | `getAllPushRules`, `getGlobalPushRules`, `getPushRulesByKind`, `getPushRule`, `putPushRule`, `deletePushRule`, `getPushRuleEnabled`, `putPushRuleEnabled`, `getPushRuleActions`, `putPushRuleActions` |
| `src/handlers/pushers.ts` | `getPushers`, `postPushersSet` |
| `src/handlers/relations.ts` | `getRelations` |
| `src/handlers/voip.ts` | `getTurnServer` |
| `src/handlers/report.ts` | `postReportEvent` |
| `src/handlers/openid.ts` | `postOpenIdToken` |
| `src/handlers/threepid.ts` | `getThreePids`, `postAddThreePid`, `postDeleteThreePid` |
| `src/handlers/user-directory.ts` | `postUserDirectorySearch` |
| `src/handlers/threads.ts` | `getThreads` |
| `src/handlers/notifications.ts` | `getNotifications` |
| `src/handlers/search.ts` | `postSearch` |
| `src/handlers/spaces.ts` | `getSpaceHierarchy` |
| `src/handlers/room-upgrade.ts` | `postRoomUpgrade` |
| `src/handlers/federation/keys.ts` | `getServerKeys` |
| `src/handlers/federation/query.ts` | `getQueryProfile`, `getQueryDirectory`, `getFederationPublicRooms` |
| `src/handlers/federation/events.ts` | `getFederationEvent`, `getFederationRoomState`, `getFederationRoomStateIds`, `getFederationEventAuth`, `postFederationBackfill`, `postFederationMissingEvents` |
| `src/handlers/federation/devices.ts` | `postFederationUserDevices`, `postFederationKeysQuery`, `postFederationKeysClaim` |
| `src/handlers/federation/transactions.ts` | `putFederationSend` |
| `src/handlers/federation/membership.ts` | `getMakeJoin`, `putSendJoin`, `getMakeLeave`, `putSendLeave`, `putFederationInvite` |

---

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "Node16",
    "moduleResolution": "Node16",
    "rewriteRelativeImportExtensions": true,
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

**`noUncheckedIndexedAccess: true`** — Array/object index access returns `T | undefined`. This is why you see patterns like `array[0]!` with non-null assertion when the index is known to be valid.

**`noUnusedLocals` / `noUnusedParameters`** — Any unused variable or parameter is a compile error. Prefix with `_` to suppress (e.g., `_serverName`).

**`rewriteRelativeImportExtensions: true`** — When compiling, `.ts` imports are rewritten to `.js`. This is why all imports use `.ts` extensions.

---

## Conventions

### Import Extensions
Always use `.ts` extensions in imports:
```typescript
import { buildEvent } from "./events.ts";
import type { Storage } from "../storage/interface.ts";
```
Node 24 handles `.ts` files natively via type stripping. The TypeScript compiler rewrites to `.js` for the `dist/` build.

### No TypeScript Parameter Properties
Node 24's type-stripping mode does NOT support TypeScript parameter properties. Never write:
```typescript
// BROKEN — will crash at runtime
class Foo {
  constructor(private name: string) {}
}
```
Instead use explicit field declarations:
```typescript
class Foo {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
```

### State Event Map Keys
Room state is stored in `Map<string, PDU>` with compound keys: `type + "\0" + state_key`. Examples:
- `"m.room.create\0"` — create event (empty state key)
- `"m.room.member\0@alice:example.com"` — membership for alice
- `"m.room.name\0"` — room name
- `"m.room.power_levels\0"` — power levels

### Room Creation Sequence
When creating a room (`postCreateRoom`), events are sent in this order:
1. `m.room.create` (state_key: "")
2. `m.room.member` for creator (state_key: creator's userId, membership: "join")
3. `m.room.power_levels` (state_key: "")
4. `m.room.join_rules` (state_key: "")
5. `m.room.history_visibility` (state_key: "")
6. `m.room.guest_access` (state_key: "")
7. `initial_state` events
8. `m.room.name` (if provided)
9. `m.room.topic` (if provided)
10. Invite events for each invitee
11. `m.room.canonical_alias` (if room alias provided)

Each event goes through `buildEvent()` → `checkEventAuth()` → `setStateEvent()` with incrementing depth and chained prev_events.

### Event Send Flow
When a client sends an event (`putSendEvent`):
1. Check transaction idempotency (`getTxnEventId`)
2. Get room state, verify sender is joined
3. Select auth events (`selectAuthEvents`)
4. Build event (`buildEvent` — computes hashes, event ID)
5. Auth check (`checkEventAuth`)
6. Store event (`storeEvent` — also increments stream counter)
7. Index relations (`indexRelation`)
8. Update room depth and forward extremities
9. Record transaction ID for idempotency

### Federation Inbound Transaction Processing (`putFederationSend`)
For each PDU in an inbound federation transaction:
1. Verify content hash (`hashes.sha256` matches `computeContentHash()`)
2. Verify event signature from origin server (fetch key via RemoteKeyStore)
3. Verify event ID matches `computeEventId()`
4. Check if event already exists (dedup)
5. Verify room exists locally
6. Check server ACL
7. Auth check against local room state
8. Store event (state or timeline)
9. Update room depth and forward extremities

### Password Storage
**Known issue:** Passwords are currently stored as plaintext (`password_hash` field is a misnomer). Login compares `body.password !== account.password_hash` directly. This needs to be replaced with bcrypt or argon2 before any real deployment. Marked with `// TODO` comments in `login.ts` and `register.ts`.
