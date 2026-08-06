import { jwtVerify, importSPKI } from "jose";
import { getSetting, setSetting } from "./settings";
import pkg from "../package.json";

/**
 * Always the PUBLIC repo, never this dev repo — customers (homelab and
 * commercial alike, per the licensing model) only ever see releases
 * published there, and the GitHub API needs no auth to read a public repo's
 * releases.
 */
const UPDATE_REPO = "Kr1sCode/adminreminder";
const MANIFEST_ASSET_NAME = "update-manifest.jws";
/** A version check has no reason to run more than once a day. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Public half of a keypair used ONLY for signing release announcements —
 * deliberately not the same key that signs license tokens (lib/license.ts).
 * Compromising this one lets an attacker point every install at a malicious
 * "verified" update; compromising the license key only lets someone forge
 * free licenses. Different blast radius, different key.
 */
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA38vjMBTcsC7UmvN5X8iNc/VY/eWYL3SvzlL2ZxwrB+w=
-----END PUBLIC KEY-----`;

interface SignedManifest {
  version: string;
  notesUrl: string;
  /** Both present together or not at all — see update-tools/sign-release.js. */
  installerUrl?: string;
  installerSha256?: string;
  /** Linux/Docker counterpart of installerUrl/installerSha256: a source
   *  tarball (git archive) instead of an .exe. Also both-or-neither. */
  sourceUrl?: string;
  sourceSha256?: string;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  notesUrl: string;
  /** Only set when the SIGNED manifest carries an installer + hash for it.
   *  lib/windows-updater.ts refuses to run anything not matching this hash. */
  installerUrl?: string;
  installerSha256?: string;
  /** Linux counterpart — lib/linux-updater.ts hands these to the updater
   *  sidecar, which re-downloads and re-hashes before touching anything. */
  sourceUrl?: string;
  sourceSha256?: string;
  /** True only when this OS can actually run the download-and-run flow AND
   *  the manifest actually offers an installer/source for it. The dashboard
   *  shows the "Zainstaluj teraz" button only when this is true; otherwise
   *  it falls back to a plain link, same as before auto-install existed.
   *  On Linux this additionally requires UPDATER_URL + UPDATE_SECRET to be
   *  configured — most Linux deployments don't run the updater sidecar, and
   *  for those this must stay false. */
  canAutoInstall: boolean;
  /** Which install-progress copy the dashboard shows: the two paths take
   *  wildly different real time. Windows' /VERYSILENT install finishes in
   *  seconds; Linux's rebuilds a Docker image first (npm ci + next build)
   *  before the app container even goes down — several minutes on modest
   *  hardware (observed ~7 min on a 2 vCPU/2 GB LXC), not the "back in a
   *  minute" a shared, OS-unaware message would promise. */
  platform: "win32" | "linux";
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Downloads and verifies the signed manifest off the latest GitHub release. */
async function fetchSignedManifest(): Promise<SignedManifest | null> {
  const releaseRes = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!releaseRes.ok) return null;
  const release = await releaseRes.json();

  const asset = (release.assets || []).find((a: any) => a.name === MANIFEST_ASSET_NAME);
  if (!asset?.browser_download_url) return null;

  const manifestRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(8000) });
  if (!manifestRes.ok) return null;
  const token = (await manifestRes.text()).trim();

  const key = await importSPKI(UPDATE_PUBLIC_KEY_PEM, "EdDSA");
  const { payload } = await jwtVerify(token, key);

  const version = payload.version;
  const notesUrl = payload.notesUrl;
  if (typeof version !== "string" || typeof notesUrl !== "string" || !parseVersion(version)) {
    return null;
  }
  // Only ever surface an http(s) link to an admin's browser.
  if (!/^https:\/\//i.test(notesUrl)) return null;

  const result: SignedManifest = { version, notesUrl };

  // installerUrl/installerSha256 are optional, but only meaningful together -
  // a hash with no URL or a URL with no hash to check it against is useless.
  const installerUrl = payload.installerUrl;
  const installerSha256 = payload.installerSha256;
  if (typeof installerUrl === "string" && typeof installerSha256 === "string") {
    // Constrains what a (validly signed) manifest could ever point the
    // downloader at, as defense in depth beyond the signature itself.
    if (
      /^https:\/\/github\.com\/Kr1sCode\/adminreminder\/releases\/download\//i.test(installerUrl) &&
      /^[0-9a-f]{64}$/i.test(installerSha256)
    ) {
      result.installerUrl = installerUrl;
      result.installerSha256 = installerSha256.toLowerCase();
    }
  }

  const sourceUrl = payload.sourceUrl;
  const sourceSha256 = payload.sourceSha256;
  if (typeof sourceUrl === "string" && typeof sourceSha256 === "string") {
    if (
      /^https:\/\/github\.com\/Kr1sCode\/adminreminder\/releases\/download\//i.test(sourceUrl) &&
      /^[0-9a-f]{64}$/i.test(sourceSha256)
    ) {
      result.sourceUrl = sourceUrl;
      result.sourceSha256 = sourceSha256.toLowerCase();
    }
  }

  return result;
}

/**
 * Checks for a newer signed release, at most once per CHECK_INTERVAL_MS
 * (cached in `settings`, so every app instance — not just one process —
 * shares the same cadence). Never throws: a network hiccup, GitHub outage,
 * or an unsigned/tampered manifest must never block startup or degrade any
 * other feature. This is a courtesy notification, not a dependency.
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  const currentVersion = pkg.version;
  const isWindows = process.platform === "win32";
  // The updater sidecar (update-tools/updater/) is opt-in per docker-compose
  // profile — most Linux deployments never run it, so the button must stay
  // hidden for them, same as it always has been.
  const hasLinuxUpdater = process.platform === "linux" && !!process.env.UPDATER_URL && !!process.env.UPDATE_SECRET;

  const toInfo = (m: {
    latestVersion: string;
    notesUrl: string;
    installerUrl?: string;
    installerSha256?: string;
    sourceUrl?: string;
    sourceSha256?: string;
  }): UpdateInfo => ({
    currentVersion,
    latestVersion: m.latestVersion,
    notesUrl: m.notesUrl,
    installerUrl: m.installerUrl,
    installerSha256: m.installerSha256,
    sourceUrl: m.sourceUrl,
    sourceSha256: m.sourceSha256,
    available: isNewer(m.latestVersion, currentVersion),
    canAutoInstall:
      (isWindows && !!m.installerUrl && !!m.installerSha256) ||
      (hasLinuxUpdater && !!m.sourceUrl && !!m.sourceSha256),
    platform: isWindows ? "win32" : "linux",
  });

  if (!force) {
    const cachedAt = Number((await getSetting("update_check_at")) || 0);
    const cached = await getSetting("update_check_result");
    if (cached && Date.now() - cachedAt < CHECK_INTERVAL_MS) {
      try {
        return toInfo(JSON.parse(cached));
      } catch {
        // Corrupt cache: fall through to a fresh check.
      }
    }
  }

  try {
    const manifest = await fetchSignedManifest();
    await setSetting("update_check_at", String(Date.now()));
    if (!manifest) return null;

    const cacheable = {
      latestVersion: manifest.version,
      notesUrl: manifest.notesUrl,
      installerUrl: manifest.installerUrl,
      installerSha256: manifest.installerSha256,
      sourceUrl: manifest.sourceUrl,
      sourceSha256: manifest.sourceSha256,
    };
    await setSetting("update_check_result", JSON.stringify(cacheable));

    return toInfo(cacheable);
  } catch {
    return null;
  }
}
