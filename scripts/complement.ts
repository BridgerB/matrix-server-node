// Run Complement tests against this homeserver.
//
// Node runs this TypeScript directly (type-stripping, no flags needed):
//
//   node scripts/complement.ts                    # run all tests
//   node scripts/complement.ts -run TestRegister  # run a specific test
//   node scripts/complement.ts -count 1 -v        # verbose, no caching
//
// Prerequisites:
//   - Docker installed and running
//   - Go installed
//   - The Complement submodule checked out at upstream/complement:
//       git submodule update --init upstream/complement
//
// Env overrides: COMPLEMENT_DIR, COMPLEMENT_TIMEOUT, COMPLEMENT_DEBUG,
// COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(scriptDir);

// Default to the vendored submodule rather than a throwaway /tmp checkout, so
// the Complement revision is pinned alongside the server it tests.
const complementDir =
	process.env.COMPLEMENT_DIR ?? join(projectDir, "upstream", "complement");

if (!existsSync(join(complementDir, "go.mod"))) {
	console.error(`Complement not found at ${complementDir}`);
	console.error(
		"Initialise the submodule: git submodule update --init upstream/complement",
	);
	process.exit(1);
}

const imageName = "complement-matrix-server-node";

console.log("Building Complement Docker image...");
const build = spawnSync(
	"docker",
	[
		"build",
		"-t",
		imageName,
		"-f",
		join(projectDir, "Dockerfile.complement"),
		projectDir,
	],
	{ stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

console.log("Running Complement tests...");
const test = spawnSync(
	"go",
	[
		"test",
		"-timeout",
		process.env.COMPLEMENT_TIMEOUT ?? "300s",
		...process.argv.slice(2),
		"./tests/...",
	],
	{
		cwd: complementDir,
		stdio: "inherit",
		env: {
			...process.env,
			COMPLEMENT_BASE_IMAGE: imageName,
			COMPLEMENT_DEBUG: process.env.COMPLEMENT_DEBUG ?? "0",
			COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS:
				process.env.COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS ?? "0",
		},
	},
);
process.exit(test.status ?? 1);
