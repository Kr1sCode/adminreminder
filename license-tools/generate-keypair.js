#!/usr/bin/env node
// One-time setup: mints the Ed25519 keypair the whole license system relies
// on. Run once, then:
//  1. paste the printed PUBLIC key PEM into lib/license.ts's
//     LICENSE_PUBLIC_KEY_PEM and ship it — safe to commit, it can only verify.
//  2. save the PRIVATE key PEM somewhere that is NOT this git repo (password
//     manager, offline backup). Losing it means every future license needs a
//     new keypair, which forces every existing customer to re-key too.
"use strict";
const { generateKeyPair, exportPKCS8, exportSPKI } = require("jose");

(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  console.log("=== KLUCZ PUBLICZNY (lib/license.ts, bezpieczny do commitowania) ===\n");
  console.log(await exportSPKI(publicKey));
  console.log("\n=== KLUCZ PRYWATNY (poza repo, NIGDY nie commitowac) ===\n");
  console.log(await exportPKCS8(privateKey));
})();
