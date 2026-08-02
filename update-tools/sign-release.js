#!/usr/bin/env node
// Vendor-only tool: signs a release-announcement manifest for the in-app
// update check (lib/update-check.ts). Needs the PRIVATE half of the
// update-signing keypair — a DIFFERENT key from license-tools/, deliberately:
// a compromised license key lets someone forge free licenses, a compromised
// update-signing key lets someone push a "verified" malicious update to every
// install that checks in. Never reuse one for the other.
//
// Usage:
//   node update-tools/sign-release.js --version 1.3.0 \
//     --notes-url https://github.com/Kr1sCode/adminreminder/releases/tag/v1.3.0 \
//     --installer-path dist/installer/AdminReminder-Setup-1.3.0.exe \
//     --source-path dist/adminreminder-src-1.3.0.tar.gz
//
// --installer-path is optional: omit it for a platform with no auto-install
// (or before the .exe is built yet) and the manifest just won't offer one -
// the dashboard banner falls back to a plain link, same as before this
// existed. When given, its SHA-256 goes INTO the signed payload: the Windows
// auto-installer (lib/windows-updater.ts) downloads whatever installerUrl
// says and refuses to run it unless the hash matches exactly, so swapping the
// GitHub release asset without the signing key can't get code executed.
//
// --source-path is the Linux/Docker counterpart, consumed by the updater
// sidecar (update-tools/updater/) instead of lib/windows-updater.ts. It must
// be built from a clean checkout of the PUBLIC repo (never this dev repo —
// docker-compose.override.yml and similar dev-only files must not ship in a
// public release asset) with a wrapping directory so the sidecar's
// `tar --strip-components=1` lands the tree directly in the deploy dir:
//   git archive --format=tar.gz --prefix=adminreminder/ -o dist/adminreminder-src-1.3.0.tar.gz v1.3.0
//
// Publish the printed token as a release asset named exactly
// "update-manifest.jws" on the GitHub release. lib/update-check.ts looks for
// that exact filename on the latest release of the public repo.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { SignJWT, importPKCS8 } = require("jose");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const version = arg("version");
  const notesUrl = arg("notes-url");
  const installerPath = arg("installer-path");
  const installerUrlOverride = arg("installer-url");
  const sourcePath = arg("source-path");
  const sourceUrlOverride = arg("source-url");
  const keyPath = arg(
    "private-key",
    path.join(os.homedir(), "adminreminder-update-signing-private-key.pem")
  );

  if (!version || !notesUrl) {
    console.error(
      "Uzycie: node update-tools/sign-release.js --version 1.3.0 --notes-url <adres release'u> " +
        "[--installer-path <plik .exe>] [--installer-url <adres>] [--private-key sciezka.pem]"
    );
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Wersja musi byc w formacie MAJOR.MINOR.PATCH, otrzymano: ${version}`);
    process.exit(1);
  }
  if (!fs.existsSync(keyPath)) {
    console.error(
      `Nie znaleziono klucza prywatnego: ${keyPath}\nWygeneruj go tak samo jak klucz licencyjny (patrz license-tools/generate-keypair.js), ale to musi byc INNA para kluczy.`
    );
    process.exit(1);
  }

  const payload = { version, notesUrl };

  if (installerPath) {
    if (!fs.existsSync(installerPath)) {
      console.error(`Nie znaleziono instalatora: ${installerPath}`);
      process.exit(1);
    }
    payload.installerSha256 = sha256File(installerPath);
    payload.installerUrl =
      installerUrlOverride ||
      `https://github.com/Kr1sCode/adminreminder/releases/download/v${version}/${path.basename(installerPath)}`;
  }

  if (sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      console.error(`Nie znaleziono archiwum zrodel: ${sourcePath}`);
      process.exit(1);
    }
    payload.sourceSha256 = sha256File(sourcePath);
    payload.sourceUrl =
      sourceUrlOverride ||
      `https://github.com/Kr1sCode/adminreminder/releases/download/v${version}/${path.basename(sourcePath)}`;
  }

  const privateKey = await importPKCS8(fs.readFileSync(keyPath, "utf8"), "EdDSA");

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .sign(privateKey);

  console.log(token);
  console.error(`\n[sign-release] wersja: ${version} | notatki: ${notesUrl}`);
  if (payload.installerSha256) {
    console.error(`[sign-release] instalator: ${payload.installerUrl}`);
    console.error(`[sign-release] sha256: ${payload.installerSha256}`);
  } else {
    console.error("[sign-release] bez instalatora w manifescie - auto-instalacja bedzie niedostepna dla Windows w tym wydaniu.");
  }
  if (payload.sourceSha256) {
    console.error(`[sign-release] zrodla: ${payload.sourceUrl}`);
    console.error(`[sign-release] sha256: ${payload.sourceSha256}`);
  } else {
    console.error("[sign-release] bez archiwum zrodel w manifescie - auto-aktualizacja bedzie niedostepna dla Linuksa w tym wydaniu.");
  }
  console.error('[sign-release] wrzuc powyzszy token jako asset "update-manifest.jws" w GitHub Release.');
}

main();
