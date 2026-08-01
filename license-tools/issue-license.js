#!/usr/bin/env node
// Vendor-only tool: mints a signed license key for a customer. Needs the
// PRIVATE half of the keypair behind lib/license.ts's LICENSE_PUBLIC_KEY_PEM.
// Deliberately lives outside scripts/ — the Docker image and the Windows
// installer both copy that directory wholesale, and this one must never ship.
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
  const customer = arg("customer");
  const days = parseInt(arg("days", "365"), 10);
  // No real-world install approaches a million tracked items; this is "no
  // practical limit" without literally special-casing Infinity in the token.
  const maxItems = parseInt(arg("max-items", "1000000"), 10);
  const keyPath = arg("private-key", path.join(os.homedir(), "adminreminder-license-private-key.pem"));

  if (!customer) {
    console.error(
      'Uzycie: node license-tools/issue-license.js --customer "Nazwa klienta" [--days 365] [--max-items 1000000] [--private-key sciezka.pem]'
    );
    process.exit(1);
  }
  if (!fs.existsSync(keyPath)) {
    console.error(`Nie znaleziono klucza prywatnego: ${keyPath}\nWygeneruj go najpierw: node license-tools/generate-keypair.js`);
    process.exit(1);
  }

  const privateKey = await importPKCS8(fs.readFileSync(keyPath, "utf8"), "EdDSA");

  const token = await new SignJWT({ maxItems })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(customer)
    .setIssuedAt()
    .setExpirationTime(`${days}d`)
    .sign(privateKey);

  console.log(token);
  console.error(`\n[issue-license] klient: ${customer} | limit pozycji: ${maxItems} | wazna ${days} dni od dzisiaj.`);
}

main();
