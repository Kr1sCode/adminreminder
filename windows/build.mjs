// Assembles the staging directory that AdminReminder.iss packages into the
// Windows installer. Runs after `npm run build`, on the CI runner (see
// .github/workflows/windows-installer.yml).
//
// Copies exactly the same set of paths as Dockerfile's runner stage - deliberately
// NOT a wildcard copy of .next/standalone/*, which in this project also contains
// the whole repo tree (README, docs/*.docx, AR_screenshots, docker-compose*.yml,
// and worst of all a developer's local ar.db) because of how output file tracing
// resolves here. Shipping that db to a customer would leak whatever is in the
// maintainer's local dev database, so every path below is an explicit allowlist.
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const standalone = path.join(repoRoot, ".next", "standalone");
const outDir = path.join(repoRoot, "dist", "win", "app");

function need(p) {
  if (!existsSync(p)) {
    console.error(`[build.mjs] brak: ${p} - uruchom najpierw "npm run build"`);
    process.exit(1);
  }
  return p;
}

console.log(`[build.mjs] czyszczenie ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copy = (from, to, opts = {}) => cpSync(from, to, { recursive: true, ...opts });

copy(need(path.join(standalone, "server.js")), path.join(outDir, "server.js"));
copy(need(path.join(standalone, "package.json")), path.join(outDir, "package.json"));
copy(need(path.join(standalone, ".next")), path.join(outDir, ".next"));
copy(need(path.join(repoRoot, ".next", "static")), path.join(outDir, ".next", "static"));
copy(need(path.join(repoRoot, "public")), path.join(outDir, "public"));
copy(need(path.join(repoRoot, "scripts")), path.join(outDir, "scripts"));

// scripts/init-db.js requires this outside the Next bundle, as a real file on
// disk — same reason scripts/ itself is copied explicitly rather than trusted
// to tracing (see Dockerfile's identical comment).
copy(
  need(path.join(repoRoot, "lib", "db-encryption.js")),
  path.join(outDir, "lib", "db-encryption.js")
);

// Output file tracing sometimes grabs only a partial copy of a native module
// (see Dockerfile's identical comment) - overlay the full, freshly npm-ci'd
// directories on top so require() never falls over on a missing binding.
copy(need(path.join(standalone, "node_modules")), path.join(outDir, "node_modules"));
for (const native of ["argon2", "better-sqlite3-multiple-ciphers"]) {
  copy(
    need(path.join(repoRoot, "node_modules", native)),
    path.join(outDir, "node_modules", native)
  );
}

// The service entry point and the .env generator ship next to server.js so
// AdminReminder.iss can point NSSM straight at them with no extra pathing.
copy(
  path.join(repoRoot, "windows", "service-entry.js"),
  path.join(outDir, "service-entry.js")
);
copy(path.join(repoRoot, "windows", "generate-env.js"), path.join(outDir, "generate-env.js"));

console.log(`[build.mjs] gotowe: ${outDir}`);
