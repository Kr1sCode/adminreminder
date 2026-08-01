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

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  notesUrl: string;
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
async function fetchSignedManifest(): Promise<{ version: string; notesUrl: string } | null> {
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

  return { version, notesUrl };
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

  if (!force) {
    const cachedAt = Number((await getSetting("update_check_at")) || 0);
    const cached = await getSetting("update_check_result");
    if (cached && Date.now() - cachedAt < CHECK_INTERVAL_MS) {
      try {
        const parsed = JSON.parse(cached);
        return {
          currentVersion,
          latestVersion: parsed.latestVersion,
          notesUrl: parsed.notesUrl,
          available: isNewer(parsed.latestVersion, currentVersion),
        };
      } catch {
        // Corrupt cache: fall through to a fresh check.
      }
    }
  }

  try {
    const manifest = await fetchSignedManifest();
    await setSetting("update_check_at", String(Date.now()));
    if (!manifest) return null;

    await setSetting(
      "update_check_result",
      JSON.stringify({ latestVersion: manifest.version, notesUrl: manifest.notesUrl })
    );

    return {
      available: isNewer(manifest.version, currentVersion),
      currentVersion,
      latestVersion: manifest.version,
      notesUrl: manifest.notesUrl,
    };
  } catch {
    return null;
  }
}
