#!/usr/bin/env node
"use strict";
// Sidecar with docker.sock access (see ../../docker-compose.prod.yml, the
// "updater" service — opt-in via `--profile selfupdate`). Deliberately kept
// out of the main "app" container: that one runs cap_drop: ALL and
// no-new-privileges on purpose (it also holds AD/Entra/SMTP secrets), and a
// container with docker.sock is effectively root on the host. Splitting this
// into its own minimal, single-purpose container keeps that hardening intact
// for everything else.
//
// This process does NOT trust lib/linux-updater.ts's request body for
// anything security-relevant — it only takes "go" from it. Everything that
// determines what gets downloaded and run (version, sourceUrl, sourceSha256)
// is re-derived here by independently re-fetching and re-verifying the
// SIGNED manifest, exactly like lib/update-check.ts does. That way a
// compromised app container (the thing this sidecar exists to rebuild) can
// trigger an update but cannot use this endpoint to make it run arbitrary
// code — it would need the update-signing private key for that, same as
// swapping a GitHub release asset would.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { jwtVerify, importSPKI } = require("jose");

const UPDATE_REPO = "Kr1sCode/adminreminder";
const MANIFEST_ASSET_NAME = "update-manifest.jws";

// Same key as UPDATE_PUBLIC_KEY_PEM in ../../lib/update-check.ts — public,
// so duplicating it here (rather than sharing a module across two separate
// Docker build contexts) is not a secret-management problem, just something
// to keep in sync if that key is ever rotated.
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA38vjMBTcsC7UmvN5X8iNc/VY/eWYL3SvzlL2ZxwrB+w=
-----END PUBLIC KEY-----`;

const UPDATE_SECRET = process.env.UPDATE_SECRET;
const PORT = Number(process.env.PORT || 8090);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/workspace";
const COMPOSE_FILES = (process.env.COMPOSE_FILES || "docker-compose.prod.yml,docker-compose.override.yml")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const COMPOSE_SERVICE = process.env.COMPOSE_SERVICE || "app";
// Never overwritten by a release tarball: server-local secrets and this
// deployment's own docker-compose.override.yml (real internal DNS IPs on
// CT102 — see docker-compose.override.yml's own comment). A public release
// tarball must never ship that file anyway (see sign-release.js), but this
// exclude list is what actually protects it, independent of that.
const PRESERVE = [".env", ".env.demo", "docker-compose.override.yml", "ar.db", "ar.db-shm", "ar.db-wal", "data"];

if (!UPDATE_SECRET) {
  console.error("[updater] UPDATE_SECRET nie jest ustawiony — odmawiam startu.");
  process.exit(1);
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function currentVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, "package.json"), "utf8"));
  return pkg.version;
}

/** Independent copy of lib/update-check.ts's fetchSignedManifest — see the
 *  file-level comment for why this doesn't just trust the caller instead. */
async function fetchSignedManifest() {
  const releaseRes = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!releaseRes.ok) throw new Error(`GitHub API HTTP ${releaseRes.status}`);
  const release = await releaseRes.json();

  const asset = (release.assets || []).find((a) => a.name === MANIFEST_ASSET_NAME);
  if (!asset?.browser_download_url) throw new Error("brak update-manifest.jws w najnowszym release");

  const manifestRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(8000) });
  if (!manifestRes.ok) throw new Error(`pobranie manifestu HTTP ${manifestRes.status}`);
  const token = (await manifestRes.text()).trim();

  const key = await importSPKI(UPDATE_PUBLIC_KEY_PEM, "EdDSA");
  const { payload } = await jwtVerify(token, key);

  const version = payload.version;
  const sourceUrl = payload.sourceUrl;
  const sourceSha256 = payload.sourceSha256;
  if (typeof version !== "string" || !parseVersion(version)) throw new Error("manifest: wersja niepoprawna");
  if (typeof sourceUrl !== "string" || typeof sourceSha256 !== "string") {
    throw new Error("manifest nie zawiera zrodel (sourceUrl/sourceSha256)");
  }
  if (!/^https:\/\/github\.com\/Kr1sCode\/adminreminder\/releases\/download\//i.test(sourceUrl)) {
    throw new Error("sourceUrl spoza oczekiwanego repo/release");
  }
  if (!/^[0-9a-f]{64}$/i.test(sourceSha256)) throw new Error("sourceSha256 ma zly ksztalt");

  return { version, sourceUrl, sourceSha256: sourceSha256.toLowerCase() };
}

async function downloadAndVerifySource(sourceUrl, expectedSha256) {
  const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`pobranie zrodel HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`hash zrodel nie zgadza sie z podpisanym manifestem (oczekiwano ${expectedSha256}, otrzymano ${actual}) — odrzucono`);
  }
  return buf;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function extractAndSync(tarballBuf) {
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ar-src-"));
  const tarPath = path.join(tmpBase, "source.tar.gz");
  const extractDir = path.join(tmpBase, "extracted");
  await fs.promises.mkdir(extractDir);
  await fs.promises.writeFile(tarPath, tarballBuf);

  // --strip-components=1: the release tarball has a wrapping directory (see
  // sign-release.js's `git archive --prefix=adminreminder/` instructions).
  await run("tar", ["-xzf", tarPath, "-C", extractDir, "--strip-components=1"]);

  const rsyncArgs = ["-a", "--delete"];
  for (const name of PRESERVE) rsyncArgs.push(`--exclude=${name}`);
  rsyncArgs.push(`${extractDir}/`, `${DEPLOY_DIR}/`);
  await run("rsync", rsyncArgs);

  await fs.promises.rm(tmpBase, { recursive: true, force: true });
}

async function rebuild() {
  const args = ["compose"];
  for (const f of COMPOSE_FILES) args.push("-f", f);
  args.push("up", "-d", "--build", COMPOSE_SERVICE);
  await run("docker", args, { cwd: DEPLOY_DIR });
}

let busy = false;

async function handleUpdate(req, res) {
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${UPDATE_SECRET}`;
  const authBuf = Buffer.from(auth);
  const expectedBuf = Buffer.from(expected);
  const authOk = authBuf.length === expectedBuf.length && crypto.timingSafeEqual(authBuf, expectedBuf);
  if (!authOk) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (busy) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "aktualizacja juz trwa" }));
    return;
  }
  busy = true;

  try {
    const manifest = await fetchSignedManifest();
    const current = currentVersion();
    if (!isNewer(manifest.version, current)) {
      throw new Error(`manifest (${manifest.version}) nie jest nowszy niz zainstalowana wersja (${current})`);
    }

    console.log(`[updater] aktualizacja ${current} -> ${manifest.version}, pobieram zrodla...`);
    const buf = await downloadAndVerifySource(manifest.sourceUrl, manifest.sourceSha256);

    console.log("[updater] hash zgodny, rozpakowuje i synchronizuje...");
    await extractAndSync(buf);

    console.log("[updater] docker compose up -d --build...");
    await rebuild();

    console.log(`[updater] gotowe: ${manifest.version}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, version: manifest.version }));
  } catch (err) {
    console.error("[updater] blad:", err.stderr || err.message || err);
    try {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    } catch {
      // The caller (the app container this just rebuilt) may already be
      // gone by the time we try to reply — that is the expected outcome on
      // success, see lib/linux-updater.ts.
    }
  } finally {
    busy = false;
  }
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  if (req.method === "POST" && req.url === "/update") {
    handleUpdate(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[updater] nasluchuje na porcie ${PORT}, katalog wdrozenia: ${DEPLOY_DIR}`);
});
