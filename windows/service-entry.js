// NSSM launches this DIRECTLY (node.exe service-entry.js) instead of going
// through a PowerShell wrapper. A Windows service whose process tree spawns
// powershell.exe is exactly the "living off the land" persistence pattern
// Defender's ML-based cloud protection watches for — it happened here
// (Trojan:Win32/Wacatac.B!ml, a well-documented false-positive for unsigned
// installers with this shape). Doing the .env load in plain Node removes
// that specific red flag entirely; nothing in this service's process tree
// touches powershell.exe anymore.
//
// Reads .env from ProgramData at every start rather than baking values into
// the service config, so editing the file and restarting the service is the
// whole reconfiguration workflow - the same thing the Docker .env already
// trains an operator to do.
"use strict";

const fs = require("fs");
const path = require("path");

const dataDir = path.join(process.env.ProgramData || "C:\\ProgramData", "AdminReminder");
const envFile = path.join(dataDir, ".env");

if (!fs.existsSync(envFile)) {
  console.error(`Brak pliku konfiguracyjnego: ${envFile}. Uruchom ponownie instalator albo utworz go recznie (patrz generate-env.js).`);
  process.exit(1);
}

for (const rawLine of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  // Split on the FIRST "=" only - secrets are base64 and often contain "="
  // padding or embedded characters that must survive intact in the value.
  const idx = line.indexOf("=");
  if (idx === -1) continue;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (key) process.env[key] = value;
}

fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });

// scripts/init-db.js is a script, not a module - require() runs it inline in
// THIS process (no child process spawned) and it calls db.close() itself.
process.chdir(__dirname);
require("./scripts/init-db.js");

require("./server.js");
