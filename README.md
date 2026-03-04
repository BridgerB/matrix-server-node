# matrix-server-node

A Matrix homeserver written in TypeScript, running on Node.js with no frameworks.

## Storage Backends

- **memory** — In-memory Maps/Sets. Fastest, but no persistence.
- **sqlite** — Synchronous SQLite via `better-sqlite3` with WAL mode. Best overall performance.
- **postgres** — PostgreSQL via `pg` with connection pooling. Native JSONB, BIGSERIAL, BYTEA types.
- **mysql** — MySQL/MariaDB via `mariadb` driver. Works with both MySQL and MariaDB.

Set via `STORAGE` env var (default: `sqlite`).

For postgres/mysql, set `DATABASE_URL` (e.g. `postgres://user:pass@host/db` or `mysql://user:pass@host/db`).

## Benchmarks

500 messages, 10 concurrent workers, Docker (2 CPU / 4 GB), Node 24.

### Storage backends

| Storage | Sequential (msg/s) | Concurrent (msg/s) |
|---|---|---|
| memory (no Docker) | 2,220 | 5,958 |
| sqlite (better-sqlite3) | 1,133 | 3,263 |
| postgres (pg) | 574 | 2,397 |
| mysql (mariadb) | 193 | 668 |

### Comparison with other Matrix servers

All servers run in Docker with 2 CPU / 4 GB limits.

| Server | Language | Storage | Sequential (msg/s) | Concurrent (msg/s) |
|---|---|---|---|---|
| **matrix-server-node** | TypeScript | SQLite | 1,133 | 3,263 |
| Conduit | Rust | RocksDB | 1,177 | 2,498 |
| Tuwunel | Rust | RocksDB | 869 | 1,826 |
| Continuwuity | Rust | RocksDB | 845 | 1,456 |
| **matrix-server-node** | TypeScript | PostgreSQL | 574 | 2,397 |
| **matrix-server-node** | TypeScript | MariaDB | 193 | 668 |
| Dendrite | Go | Postgres | 92 | 102 |
| Synapse | Python | Postgres | 52 | 108 |
