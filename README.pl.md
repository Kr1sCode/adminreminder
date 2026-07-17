# AdminReminder

**Monitor terminów ważności — od admina dla admina.**
Pomysł i wykonanie: [www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

[English](README.md) · **Polski**

> **Demo na żywo:** **https://adminreminder.krzysztofgawkowski.pl** — zaloguj się
> `demo` / `demo123`. Demo działa w trybie tylko do odczytu (pokazuje przykładowe
> dane dla każdego typu pozycji i zakładek ustawień).

AdminReminder (AR) pomaga administratorom śledzić terminy ważności i odnowień w
jednym, szybkim i ładnym miejscu — zamiast listy w SharePoint czy Excelu:

- **Certyfikaty HTTPS** — automatyczne pobieranie daty ważności
- **Punkty TLS** — LDAPS, VPN, Exchange, RD Gateway i inne usługi na dowolnym
  porcie (data ważności plus łańcuch, EKU, zgodność nazwy, opcjonalny pin SHA-256)
- **Gwarancje sprzętu**
- **Sekrety i certyfikaty w Entra ID / Azure** (App registrations → Graph API)
- **Tokeny / klucze API**, **licencje oprogramowania**, **rejestracje domen** (RDAP)
- oraz dowolne inne pozycje z datą ważności.

![Dashboard](screenshots/AR_dashboard.jpg)

## Główne cechy

- Logowanie z rolami (**admin** / **viewer**) oraz **MFA (TOTP)**
- Wiele typów pozycji: Certyfikat HTTPS, Punkt TLS (LDAPS/usługa), Gwarancja,
  Sekret Entra/Azure, Token API, Licencja, Domena, Inne
- Przejrzysty dashboard z kolorowymi statusami (jasny i ciemny motyw)
- Automatyczne sprawdzanie: certyfikaty HTTPS, punkty TLS, rejestracje domen (RDAP)
- Powiadomienia **e-mail** (SMTP / Resend) i **webhook**, progi per-pozycja
- Inwentarz kont z **Active Directory** (LDAP) i **Entra ID** (Graph)
- Historia sprawdzeń, dziennik audytu, eksport CSV
- Interfejs w 7 językach
- Next.js + SQLite — łatwy self-host, bez zewnętrznych zależności

| Ciemny motyw | Edycja pozycji |
|---|---|
| ![Dashboard dark](screenshots/AR_dashboard_dark.jpg) | ![Edycja](screenshots/AR_edit_position.jpg) |

| Ustawienia e-mail | MFA |
|---|---|
| ![E-mail](screenshots/AR_e-mail_settings.jpg) | ![MFA](screenshots/AR_MFA.png) |

## Instalacja na Proxmox VE (LXC) — zalecane

Jedno polecenie **na hoście Proxmox** tworzy nieuprzywilejowany kontener
Debian 13, instaluje natywnie Node.js i aplikację, zakłada **pustą bazę** oraz
usługę systemd (bez Dockera, bez nestingu):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kr1sCode/adminreminder/main/proxmox/install.sh)"
```

Po zakończeniu instalator wypisze adres `http://<IP-kontenera>:3000`. Przy
pierwszym otwarciu aplikacja poprosi o utworzenie konta administratora.

Aktualizacja: `pct exec <CTID> -- update`

Domyślnie kontener korzysta z DHCP. Na hostach ze statyczną adresacją podaj
`AR_IP=192.168.1.50/24 AR_GW=192.168.1.1` (opcjonalnie `AR_NS=1.1.1.1`).

> Pliki w układzie repozytorium community-scripts (pod przyszły PR) znajdziesz w
> katalogu [`community-scripts/`](community-scripts/).

## Docker

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up --build -d
```

Baza SQLite trzymana jest na wolumenie (`/app/data/ar.db`).

## Uruchomienie lokalne (dev)

```bash
git clone https://github.com/Kr1sCode/adminreminder
cd adminreminder
npm install
cp .env.example .env.local
npm run dev
```

Otwórz **http://localhost:3000** i utwórz konto administratora.

## Konfiguracja środowiska

Ważne zmienne (`.env` / `.env.local`, wzór w [`.env.example`](.env.example)):

- `DATABASE_URL` — ścieżka do pliku bazy SQLite
- `JWT_SECRET` — **długi, losowy ciąg** (w produkcji aplikacja odmawia startu z
  wartością domyślną); `openssl rand -base64 48`
- `SETTINGS_KEY` — klucz do szyfrowania sekretów w bazie (AES-256-GCM); jeśli
  pusty, wyprowadzany z `JWT_SECRET`
- `CRON_SECRET` — sekret dla zadań automatycznych
- opcjonalnie: integracje **AD** (`AD_*`) i **Entra ID** (`AZURE_*`)

Sekrety (hasła SMTP/AD, client secret Azure) są w bazie szyfrowane i nigdy nie są
odsyłane do przeglądarki.

## Jak działa sprawdzanie

- **Certyfikaty HTTPS / Punkty TLS** — bezpośrednie połączenie TLS na wskazanym
  porcie (wbudowany moduł `tls` Node.js), odczyt `valid_to` oraz walidacja
  łańcucha, EKU `serverAuth`, zgodności nazwy (SAN/CN vs host/SNI) i — opcjonalnie
  — przypiętego odcisku SHA-256 (`pin`) wykrywającego podmianę certyfikatu.
- **Domeny** — przez **RDAP** (RFC 9083), endpoint rejestru wykrywany z pliku
  bootstrap IANA.

## Stos technologiczny

- Next.js 16 (App Router) + TypeScript
- Drizzle ORM + better-sqlite3
- shadcn/ui + Tailwind (jasny/ciemny motyw)
- Argon2 + jose (JWT), TOTP (MFA)

## Licencja

Oprogramowanie własnościowe, source-available:

- **Prywatnie / homelab — bezpłatnie.** Osoba fizyczna może pobierać, uruchamiać
  i modyfikować AR na własne, prywatne, niekomercyjne potrzeby (w tym domowy lab).
- **Komercyjnie — płatna licencja i zgoda autora.** Każde użycie w firmie,
  instytucji lub innej organizacji, produkcyjnie lub zawodowo, wymaga uprzedniej,
  płatnej Licencji komercyjnej.

Pełne warunki: [LICENSE](LICENSE). Zakup licencji i kontakt:
[www.krzysztofgawkowski.pl](https://www.krzysztofgawkowski.pl)

© 2026 Krzysztof Gawkowski. Wszelkie prawa zastrzeżone.
