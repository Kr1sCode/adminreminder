// Generates a ready-to-run .env for the Windows service, run once by the
// installer's post-install step. Never overwrites an existing file: on an
// upgrade the previous secrets, and anything the operator added by hand
// (AD_*, AZURE_*, ...), must survive untouched.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg("data-dir");
const port = arg("port", "3000");
const appOrigin = arg("app-origin", `http://localhost:${port}`);

if (!dataDir) {
  console.error("Uzycie: generate-env.js --data-dir <sciezka> [--port 3000] [--app-origin http://host:3000]");
  process.exit(1);
}

const envPath = path.join(dataDir, ".env");
if (fs.existsSync(envPath)) {
  console.log(`[generate-env] ${envPath} juz istnieje, zostawiam bez zmian.`);
  process.exit(0);
}

const secret = (bytes) => crypto.randomBytes(bytes).toString("base64");
const dbPath = path.join(dataDir, "data", "ar.db");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const contents = `# Wygenerowane przez instalator AdminReminder ${new Date().toISOString()}
# Edytuj ten plik, potem zrestartuj usluge Windows "AdminReminder", zeby
# zmiany zaczely dzialac (Start-AdminReminder.ps1 czyta go przy kazdym starcie).

DATABASE_URL=${dbPath}
PORT=${port}
HOSTNAME=0.0.0.0
NODE_ENV=production
TZ=${tz}

JWT_SECRET=${secret(48)}
SETTINGS_KEY=${secret(32)}
CRON_SECRET=${secret(32)}

APP_ORIGIN=${appOrigin}

# A brand new install has no plaintext data to migrate, so encryption is on
# from the first run. Losing this key makes ar.db unrecoverable — back it up
# the same way you would back up the .env file itself.
DB_ENCRYPTION_KEY=${secret(32)}

# Integracje AD/Entra/SMTP wygodniej wlaczyc pozniej w samym UI:
# Ustawienia -> Active Directory / Entra ID / Powiadomienia. Zmienne ponizej
# (opcjonalne) omijaja UI, gdy wolisz trzymac je w pliku:
# AD_URL=ldaps://dc01.firma.local:636
# AD_BIND_DN=CN=svc-ar,OU=Service Accounts,DC=firma,DC=local
# AD_BIND_PASSWORD=
# AD_BASE_DN=DC=firma,DC=local
`;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
fs.writeFileSync(envPath, contents, { mode: 0o600 });
console.log(`[generate-env] zapisano ${envPath}`);
