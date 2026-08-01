# AdminReminder

[![GitHub stars](https://img.shields.io/github/stars/Kr1sCode/adminreminder?style=flat)](https://github.com/Kr1sCode/adminreminder/stargazers)
[![License](https://img.shields.io/badge/license-see--LICENSE-blue)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/Kr1sCode/adminreminder)](https://github.com/Kr1sCode/adminreminder/commits/main)

**Expiry-date monitor — by an admin, for admins.**
Concept & build: [www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

**English** · [Polski](README.pl.md)

> **Live demo:** **https://adminreminder.krzysztofgawkowski.pl** — log in with
> `demo` / `demo123`. The demo is read-only (it shows sample data across every
> item type and settings tab).

AdminReminder (AR) helps administrators keep track of expiry and renewal dates
in one fast, good-looking place — instead of a list in SharePoint or Excel:

- **HTTPS certificates** — expiry date fetched automatically
- **TLS endpoints** — LDAPS, VPN, Exchange, RD Gateway and other services on any
  port (expiry date plus chain, EKU, name validation and an optional SHA-256 pin)
- **AD CS certificates** — Root CA and Issuing CA, read straight from Active
  Directory's Configuration partition (a TLS handshake almost never carries a
  Root CA certificate, so a live-endpoint probe alone can't see it)
- **Hardware warranties**
- **Secrets and certificates in Entra ID / Azure** (App registrations → Graph API)
- **API keys / tokens**, **software licenses**, **domain registrations** (RDAP)
- and any other item that has an expiry date.

![Dashboard](screenshots/AR_dashboard.jpg)

## Features

### What it watches

- HTTPS certificate, TLS endpoint (LDAPS/service, with chain/EKU/name/pin
  validation), AD CS certificate (Root/Issuing CA), hardware warranty,
  Entra/Azure secret or certificate, API token, software license, domain
  registration (RDAP), or anything else with an expiry date
- A website can track its certificate and its domain registration together as
  one item — two independent expiry dates, one row on the dashboard
- Color-coded dashboard (light and dark theme), check history, audit log, CSV
  export

### Directory integration

- Account inventory from **Active Directory** (LDAP) and **Entra ID** (Graph):
  password and account expiry, nested group membership, OU tree
- Per-OU or per-account notification policies, separate thresholds for
  password vs. account expiry

### Notifications & automation

- **E-mail** (SMTP or Resend) and **webhook** notifications, with per-item
  threshold overrides
- Built-in scheduler (a cron expression configured in the UI) runs checks and
  sends notifications on its own — no external cron job required

### Security

- Login with roles (**admin** / **viewer**) and **MFA (TOTP)**
- **Two layers of encryption:**
  - every secret stored in the settings table (SMTP/AD passwords, Azure
    client secret, webhook signing key) is encrypted individually
    (AES-256-GCM) and never sent back to the browser
  - the whole SQLite database can optionally be encrypted at rest with
    **SQLCipher** (`DB_ENCRYPTION_KEY`) — turning it on for an existing,
    already-populated install converts the file in place on the next start,
    no export/import step
- Full audit log of admin actions (automatic checks are excluded on purpose,
  so the log isn't drowned in noise)

### REST API

Read-only REST API (`/api/v1/items`, `/api/v1/accounts`) secured with
per-integration API keys, for pulling expiry data into another dashboard,
ticketing system or AI agent.

### Licensing

The free tier tracks up to **5 items** — private/homelab use as well as
commercial. A signed license key (issued offline, no phone-home license
server) removes the limit. See [License](#license) below.

### Stays current

AdminReminder checks once a day for a newer, cryptographically signed release
and shows a dismissible banner with a link — it never downloads or installs
anything on its own. Upgrading (LXC, Docker or the Windows installer) is
always a deliberate, administrator-driven step.

### Interface

Available in **7 languages** (English, Polish, German, French, Spanish,
Italian, Turkish).

| Dark theme | Edit item |
|---|---|
| ![Dashboard dark](screenshots/AR_dashboard_dark.jpg) | ![Edit item](screenshots/AR_edit_position.jpg) |

| E-mail settings | MFA |
|---|---|
| ![E-mail](screenshots/AR_e-mail_settings.jpg) | ![MFA](screenshots/AR_MFA.png) |

## Installation

### Proxmox VE (LXC) — recommended

A single command **on the Proxmox host** creates an unprivileged Debian 13
container, installs Node.js and the app natively, sets up an **empty database**
and a systemd service (no Docker, no nesting):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kr1sCode/adminreminder/main/proxmox/install.sh)"
```

When it finishes, the installer prints the address `http://<container-IP>:3000`.
On first open the app asks you to create an administrator account.

Update: `pct exec <CTID> -- update`

By default the container uses DHCP. On hosts with static addressing pass
`AR_IP=192.168.1.50/24 AR_GW=192.168.1.1` (optionally `AR_NS=1.1.1.1`).

> Files following the community-scripts repository layout (for a possible future
> PR) live in [`community-scripts/`](community-scripts/).

### Docker

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up --build -d
```

The SQLite database is kept on a volume (`/app/data/ar.db`).

### Windows

A native installer (`.exe`) is available for admins who run everything
directly on Windows Server rather than Proxmox or Docker: it installs
AdminReminder as a Windows service (via NSSM), asks for a port and a public
address during setup, adds the matching firewall rule, and generates a fresh
`.env` with random secrets and — for a brand new install — database encryption
turned on from the very first run. See the latest [Release](../../releases)
for the download, or build it yourself from the [`windows/`](windows/)
directory (GitHub Actions workflow: `windows-installer.yml`).

### Local development

```bash
git clone https://github.com/Kr1sCode/adminreminder
cd adminreminder
npm install
cp .env.example .env.local
npm run dev
```

Open **http://localhost:3000** and create an administrator account.

## Environment configuration

Important variables (`.env` / `.env.local`, template in [`.env.example`](.env.example)):

- `DATABASE_URL` — path to the SQLite database file
- `JWT_SECRET` — a **long, random string** (in production the app refuses to
  start with the default value); `openssl rand -base64 48`
- `SETTINGS_KEY` — key used to encrypt secrets stored in the database
  (AES-256-GCM); if empty, it is derived from `JWT_SECRET`
- `CRON_SECRET` — secret for automated jobs
- `DB_ENCRYPTION_KEY` — optional; encrypts the whole database file at rest
  with SQLCipher (see [Security](#security) above)
- optional: **AD** (`AD_*`) and **Entra ID** (`AZURE_*`) integrations

Secrets (SMTP/AD passwords, Azure client secret) are encrypted in the database
and are never sent back to the browser.

## How checking works

- **HTTPS certificates / TLS endpoints** — a direct TLS connection to the given
  port (Node.js built-in `tls` module), reading `valid_to` and validating the
  chain, the `serverAuth` EKU, name matching (SAN/CN vs host/SNI) and — optionally
  — a pinned SHA-256 fingerprint (`pin`) that detects certificate replacement.
- **AD CS certificates** — a search against Active Directory's Configuration
  naming context (`CN=Certification Authorities` and `CN=AIA`), reading the
  `cACertificate` attribute directly — no live TLS endpoint involved.
- **Domains** — via **RDAP** (RFC 9083), with the registry endpoint discovered
  from the IANA bootstrap file.

## Tech stack

- Next.js 16 (App Router) + TypeScript
- Drizzle ORM + better-sqlite3 (optionally SQLCipher via better-sqlite3-multiple-ciphers)
- shadcn/ui + Tailwind (light/dark theme)
- Argon2 + jose (JWT / license keys / signed release manifests), TOTP (MFA)

## License

Proprietary, source-available software:

- **Private / homelab — free**, up to **5 tracked items**. An individual may
  download, run and modify AR for their own private, non-commercial needs
  (including a home lab).
- **Commercial — paid license and the author's permission.** Any use inside a
  company, institution or other organization, in production or professionally,
  requires a valid, paid Commercial License obtained in advance.
- A license key removes the 5-item limit for either case — contact the author
  to request one.

Full terms: [LICENSE](LICENSE). Purchasing and contact:
[www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

© 2026 Krzysztof Gawkowski. All rights reserved.
