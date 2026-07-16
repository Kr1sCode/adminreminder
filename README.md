# Admin Redminer

**Expiry-date monitor — by an admin, for admins.**
Concept & build: [www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

**English** · [Polski](README.pl.md)

Admin Redminer (AR) helps administrators keep track of expiry and renewal dates
in one fast, good-looking place — instead of a list in SharePoint or Excel:

- **HTTPS certificates** — expiry date fetched automatically
- **TLS endpoints** — LDAPS, VPN, Exchange, RD Gateway and other services on any
  port (expiry date plus chain, EKU, name validation and an optional SHA-256 pin)
- **Hardware warranties**
- **Secrets and certificates in Entra ID / Azure** (App registrations → Graph API)
- **API keys / tokens**, **software licenses**, **domain registrations** (RDAP)
- and any other item that has an expiry date.

![Dashboard](screenshots/AR_dashboard.jpg)

## Features

- Login with roles (**admin** / **viewer**) and **MFA (TOTP)**
- Multiple item types: HTTPS certificate, TLS endpoint (LDAPS/service), Warranty,
  Entra/Azure secret, API token, License, Domain, Other
- Clear dashboard with color-coded statuses (light and dark theme)
- Automatic checks: HTTPS certificates, TLS endpoints, domain registrations (RDAP)
- **E-mail** (SMTP / Resend) and **webhook** notifications, per-item thresholds
- Account inventory from **Active Directory** (LDAP) and **Entra ID** (Graph)
- Check history, audit log, CSV export
- Interface available in 7 languages
- Next.js + SQLite — easy self-hosting, no external dependencies

| Dark theme | Edit item |
|---|---|
| ![Dashboard dark](screenshots/AR_dashboard_dark.jpg) | ![Edit item](screenshots/AR_edit_position.jpg) |

| E-mail settings | MFA |
|---|---|
| ![E-mail](screenshots/AR_e-mail_settings.jpg) | ![MFA](screenshots/AR_MFA.png) |

## Install on Proxmox VE (LXC) — recommended

A single command **on the Proxmox host** creates an unprivileged Debian 13
container, installs Node.js and the app natively, sets up an **empty database**
and a systemd service (no Docker, no nesting):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kr1sCode/adminredminer/main/proxmox/install.sh)"
```

When it finishes, the installer prints the address `http://<container-IP>:3000`.
On first open the app asks you to create an administrator account.

Update: `pct exec <CTID> -- update`

By default the container uses DHCP. On hosts with static addressing pass
`AR_IP=192.168.1.50/24 AR_GW=192.168.1.1` (optionally `AR_NS=1.1.1.1`).

> Files following the community-scripts repository layout (for a possible future
> PR) live in [`community-scripts/`](community-scripts/).

## Docker

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up --build -d
```

The SQLite database is kept on a volume (`/app/data/ar.db`).

## Local development

```bash
git clone https://github.com/Kr1sCode/adminredminer
cd adminredminer
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
- optional: **AD** (`AD_*`) and **Entra ID** (`AZURE_*`) integrations

Secrets (SMTP/AD passwords, Azure client secret) are encrypted in the database
and are never sent back to the browser.

## How checking works

- **HTTPS certificates / TLS endpoints** — a direct TLS connection to the given
  port (Node.js built-in `tls` module), reading `valid_to` and validating the
  chain, the `serverAuth` EKU, name matching (SAN/CN vs host/SNI) and — optionally
  — a pinned SHA-256 fingerprint (`pin`) that detects certificate replacement.
- **Domains** — via **RDAP** (RFC 9083), with the registry endpoint discovered
  from the IANA bootstrap file.

## Tech stack

- Next.js 16 (App Router) + TypeScript
- Drizzle ORM + better-sqlite3
- shadcn/ui + Tailwind (light/dark theme)
- Argon2 + jose (JWT), TOTP (MFA)

## License

Proprietary, source-available software:

- **Private / homelab — free.** An individual may download, run and modify AR
  for their own private, non-commercial needs (including a home lab).
- **Commercial — paid license and the author's permission.** Any use inside a
  company, institution or other organization, in production or professionally,
  requires a valid, paid Commercial License obtained in advance.

Full terms: [LICENSE](LICENSE). Purchasing and contact:
[www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

© 2026 Krzysztof Gawkowski. All rights reserved.
