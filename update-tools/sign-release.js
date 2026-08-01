#!/usr/bin/env node
// Vendor-only tool: signs a release-announcement manifest for the in-app
// update check (lib/update-check.ts). Needs the PRIVATE half of the
// update-signing keypair — a DIFFERENT key from license-tools/, deliberately:
// a compromised license key lets someone forge free licenses, a compromised
// update-signing key lets someone push a "verified" malicious update to every
// install that checks in. Never reuse one for the other.
//
// Usage:
//   node update-tools/sign-release.js --version 0.3.0 \
//     --notes-url https://github.com/Kr1sCode/adminreminder/releases/tag/v0.3.0
//
// Publish the printed token as a release asset named exactly
// "update-manifest.jws" on the GitHub release. lib/update-check.ts looks for
// that exact filename on the latest release of the public repo.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { SignJWT, importPKCS8 } = require("jose");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const version = arg("version");
  const notesUrl = arg("notes-url");
  const keyPath = arg(
    "private-key",
    path.join(os.homedir(), "adminreminder-update-signing-private-key.pem")
  );

  if (!version || !notesUrl) {
    console.error(
      "Uzycie: node update-tools/sign-release.js --version 0.3.0 --notes-url <adres release'u> [--private-key sciezka.pem]"
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

  const privateKey = await importPKCS8(fs.readFileSync(keyPath, "utf8"), "EdDSA");

  const token = await new SignJWT({ version, notesUrl })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .sign(privateKey);

  console.log(token);
  console.error(`\n[sign-release] wersja: ${version} | notatki: ${notesUrl}`);
  console.error('[sign-release] wrzuc powyzszy token jako asset "update-manifest.jws" w GitHub Release.');
}

main();
