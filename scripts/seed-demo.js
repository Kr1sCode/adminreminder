/**
 * Sanitised demo dataset for a PUBLIC read-only showcase instance.
 *
 * Replaces every monitored item, the check/audit history and the directory
 * inventory with neutral example data (example.com, demo-firma.pl, generic
 * team names) so a public demo never exposes real infrastructure naming.
 * Leaves users/settings untouched — a viewer cannot see them anyway.
 *
 * Usage (inside the container):
 *   docker exec -i <container> node - < scripts/seed-demo.js
 * or:
 *   DATABASE_URL=/app/data/ar.db node scripts/seed-demo.js
 */
const path = require("path");
const Database = require("better-sqlite3");

const DB = process.env.DATABASE_URL || path.join(process.cwd(), "ar.db");
const db = new Database(DB);
db.pragma("journal_mode = WAL");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const at = (days) => NOW + Math.round(days * DAY);

// Colour follows expiry vs the 30-day "expiring" threshold used on the dashboard.
const statusOf = (days) => (days < 0 ? "expired" : days <= 30 ? "expiring" : "ok");

// type, name, identifier, owner, days-to-expiry, [domainName, domainDays]
const ITEMS = [
  ["https_cert", "Certyfikat HTTPS — sklep.example.com",  "sklep.example.com", "Zespół E-commerce", 45,  "example.com", 320],
  ["https_cert", "Certyfikat HTTPS — portal.example.org", "portal.example.org", "Zespół IT",        11,  "example.org", 95],
  ["https_cert", "Certyfikat HTTPS — api.example.net",    "api.example.net",   "DevOps",            180, "example.net", 430],
  ["domain",     "Rejestracja domeny — demo-firma.pl",    "demo-firma.pl",     "Zespół IT",         26,  null, null],
  ["domain",     "Rejestracja domeny — moja-aplikacja.dev","moja-aplikacja.dev","—",                365, null, null],
  ["warranty",   "Gwarancja — serwer aplikacyjny APP-01", "SN: DEMO-APP-01",   "Serwerownia",       240, null, null],
  ["warranty",   "Gwarancja — macierz dyskowa STOR-01",   "SN: DEMO-STOR-01",  "Serwerownia",       -8,  null, null],
  ["license",    "Licencja — ochrona antywirusowa (100 stanowisk)", "AV-DEMO-100", "Bezpieczeństwo", 21, null, null],
  ["license",    "Licencja — pakiet biurowy (subskrypcja)","OFFICE-DEMO-365",  "—",                 300, null, null],
  ["azure_secret","Sekret aplikacji — Integracja API (Entra ID)", "app-integracja-api", "DevOps",   14,  null, null],
  ["api_token",  "Token API — automatyzacja n8n",         "token-n8n-automatyzacja", "Automatyzacja",60, null, null],
  ["other",      "Odnowienie — certyfikat podpisu kodu",  "code-signing-cert", "Bezpieczeństwo",    120, null, null],
];

const clear = db.transaction(() => {
  db.exec("DELETE FROM audit_log;");
  db.exec("DELETE FROM check_history;");
  db.exec("DELETE FROM ad_accounts;");
  db.exec("DELETE FROM ad_notify_policies;");
  db.exec("DELETE FROM services;");
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('services','audit_log','check_history','ad_accounts','ad_notify_policies');");
});
clear();

const insItem = db.prepare(`
  INSERT INTO services
    (type, name, identifier, port, owner, notes, custom_data, renewal_url,
     expiry_date, last_checked_at, last_check_status, last_check_error,
     domain_name, domain_expiry_date, domain_last_checked_at, domain_last_check_status, domain_last_check_error,
     notification_days, notified_thresholds, muted_until, notify_recipients, last_notified_at,
     created_at, updated_at)
  VALUES
    (@type, @name, @identifier, @port, @owner, @notes, '{}', @renewal_url,
     @expiry_date, @last_checked_at, @last_check_status, NULL,
     @domain_name, @domain_expiry_date, @domain_last_checked_at, @domain_last_check_status, NULL,
     NULL, '[]', NULL, NULL, NULL,
     @created_at, @updated_at)
`);

const seedItems = db.transaction(() => {
  for (const [type, name, identifier, owner, days, domainName, domainDays] of ITEMS) {
    const auto = type === "https_cert" || type === "domain"; // auto-checked types
    insItem.run({
      type, name, identifier, port: 443, owner, notes: null, renewal_url: null,
      expiry_date: at(days),
      last_checked_at: auto ? NOW - 3600 : null,
      last_check_status: auto ? statusOf(days) : null,
      domain_name: domainName,
      domain_expiry_date: domainName ? at(domainDays) : null,
      domain_last_checked_at: domainName ? NOW - 3600 : null,
      domain_last_check_status: domainName ? statusOf(domainDays) : null,
      created_at: NOW - 20 * DAY,
      updated_at: NOW - 2 * DAY,
    });
  }
});
seedItems();

// TLS endpoints (LDAPS / services). Seeded with a fixed verdict rather than a
// live probe: the demo host cannot reach a real .local service, and these show
// what the checker reports — an expired self-signed LDAPS cert (the real-world
// case this type exists to catch) next to a healthy VPN head-end.
const insTls = db.prepare(`
  INSERT INTO services
    (type, name, identifier, port, owner, notes, custom_data, renewal_url,
     expiry_date, last_checked_at, last_check_status, last_check_error,
     domain_name, domain_expiry_date, domain_last_checked_at, domain_last_check_status, domain_last_check_error,
     notification_days, notified_thresholds, muted_until, notify_recipients, last_notified_at,
     created_at, updated_at)
  VALUES
    (@type, @name, @identifier, @port, @owner, @notes, @custom_data, NULL,
     @expiry_date, @last_checked_at, @last_check_status, @last_check_error,
     NULL, NULL, NULL, NULL, NULL,
     NULL, '[]', NULL, NULL, NULL,
     @created_at, @updated_at)
`);
const TLS = [
  {
    name: "LDAPS — kontroler domeny dc01",
    identifier: "dc01.demo-firma.local", port: 636, owner: "Zespół IT",
    role: "LDAPS (kontroler domeny)", sni: "dc01.demo-firma.local",
    days: -208, status: "expired",
    error: "certyfikat samopodpisany; nazwa dc01.demo-firma.local nie występuje w certyfikacie (SAN: dc01)",
  },
  {
    name: "VPN — brama SSL vpn.demo-firma.pl",
    identifier: "vpn.demo-firma.pl", port: 443, owner: "Bezpieczeństwo",
    role: "VPN (brama SSL)", sni: "",
    days: 74, status: "ok", error: null,
  },
];
const seedTls = db.transaction(() => {
  for (const e of TLS) {
    insTls.run({
      type: "tls_endpoint", name: e.name, identifier: e.identifier, port: e.port,
      owner: e.owner, notes: null,
      custom_data: JSON.stringify(e.sni ? { role: e.role, sni: e.sni } : { role: e.role }),
      expiry_date: at(e.days), last_checked_at: NOW - 3600,
      last_check_status: e.status, last_check_error: e.error,
      created_at: NOW - 20 * DAY, updated_at: NOW - 2 * DAY,
    });
  }
});
seedTls();

// A little sanitised history so the "Historia zmian" tab isn't empty.
const insAudit = db.prepare(`
  INSERT INTO audit_log (at, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_name, details)
  VALUES (@at, NULL, 'admin', 'admin', @action, @entity_type, @entity_id, @entity_name, @details)
`);
const HIST = [
  [-19 * DAY, "auth.setup", null, null, null],
  [-18 * DAY, "item.create", "service", 1, "Certyfikat HTTPS — sklep.example.com"],
  [-18 * DAY, "item.create", "service", 6, "Gwarancja — serwer aplikacyjny APP-01"],
  [-10 * DAY, "settings.update", "settings", null, "Progi ważności"],
  [-3 * DAY, "item.update", "service", 4, "Rejestracja domeny — demo-firma.pl"],
  [-2 * DAY, "item.check_all", null, null, null],
  [-1 * DAY, "item.notifications", "service", 2, "Certyfikat HTTPS — portal.example.org"],
  [-1 * DAY, "ad.notifications", "ad_ou", null, "OU=Konta Serwisowe,DC=demo-firma,DC=local"],
];
const seedAudit = db.transaction(() => {
  for (const [off, action, et, eid, en] of HIST) {
    insAudit.run({ at: NOW + off, action, entity_type: et, entity_id: eid, entity_name: en, details: null });
  }
});
seedAudit();

// ── Katalog kont (Active Directory) — sanitised demo directory ──────────────
const { randomUUID } = require("crypto");
const DOM = "DC=demo-firma,DC=local";
const OU = {
  IT:  `OU=IT,OU=Uzytkownicy,${DOM}`,
  KS:  `OU=Ksiegowosc,OU=Uzytkownicy,${DOM}`,
  SP:  `OU=Sprzedaz,OU=Uzytkownicy,${DOM}`,
  ZA:  `OU=Zarzad,OU=Uzytkownicy,${DOM}`,
  SVC: `OU=Konta Serwisowe,${DOM}`,
  FUN: `OU=Konta Funkcyjne,${DOM}`,
};
// sam, name, kind, ou-key, pw(days to expiry) | never:true | disabled | acctExp | spn
const AD = [
  { sam: "anowak",       name: "Anna Nowak",             kind: "user",       ou: "IT", pw: 45 },
  { sam: "pkowalski",    name: "Piotr Kowalski",         kind: "user",       ou: "IT", pw: 12 },
  { sam: "rwozniak",     name: "Robert Woźniak",         kind: "user",       ou: "IT", pw: -60, disabled: true },
  { sam: "kwisniewska",  name: "Katarzyna Wiśniewska",   kind: "user",       ou: "KS", pw: 200 },
  { sam: "mzielinski",   name: "Marek Zieliński",        kind: "user",       ou: "KS", pw: -5 },
  { sam: "awojcik",      name: "Agnieszka Wójcik",       kind: "user",       ou: "SP", pw: 60 },
  { sam: "tkaminski",    name: "Tomasz Kamiński",        kind: "user",       ou: "SP", pw: 8 },
  { sam: "mkozlowska",   name: "Magdalena Kozłowska",    kind: "user",       ou: "SP", pw: 20, acctExp: 20 },
  { sam: "elewandowska", name: "Ewa Lewandowska",        kind: "user",       ou: "ZA", never: true },
  { sam: "jkowalczyk",   name: "Jan Kowalczyk",          kind: "user",       ou: "ZA", pw: 150 },
  { sam: "svc-backup",     name: "svc-backup",           kind: "technical",  ou: "SVC", never: true },
  { sam: "svc-sql",        name: "svc-sql",              kind: "technical",  ou: "SVC", never: true, spn: 2 },
  { sam: "svc-monitoring", name: "svc-monitoring",       kind: "technical",  ou: "SVC", never: true },
  { sam: "svc-webapp",     name: "svc-webapp",           kind: "technical",  ou: "SVC", pw: 90, spn: 1 },
  { sam: "recepcja",     name: "Recepcja (współdzielone)", kind: "functional", ou: "FUN", never: true },
  { sam: "magazyn",      name: "Magazyn (współdzielone)",  kind: "functional", ou: "FUN", pw: 25 },
  { sam: "helpdesk",     name: "Helpdesk (współdzielone)", kind: "functional", ou: "FUN", pw: 5 },
];
const KIND_REASON = {
  technical: "Prefiks svc-",
  functional: "Konto współdzielone (brak imienia i nazwiska)",
  user: null,
};
const insAd = db.prepare(`
  INSERT INTO ad_accounts
    (source, object_guid, sam_account_name, distinguished_name, ou_path, display_name, user_principal_name,
     kind, kind_reason, enabled, user_account_control, password_never_expires,
     password_expires_at, account_expires_at, last_logon_at, spn_count, last_synced_at, created_at)
  VALUES
    (@source, @guid, @sam, @dn, @ou, @display, @upn,
     @kind, @kindReason, @enabled, @uac, @never,
     @pwExp, @acctExp, @lastLogon, @spn, @synced, @created)
`);
/** sam -> objectGUID, so the notification policies below can target an account. */
const AD_GUIDS = {};

const seedAd = db.transaction(() => {
  for (const r of AD) {
    const ou = OU[r.ou];
    const enabled = r.disabled ? 0 : 1;
    const never = r.never ? 1 : 0;
    const uac = !enabled ? 514 : never ? 66048 : 512;
    AD_GUIDS[r.sam] = randomUUID();
    insAd.run({
      source: "ad",
      guid: AD_GUIDS[r.sam],
      sam: r.sam,
      dn: `CN=${r.name},${ou}`,
      ou,
      display: r.name,
      upn: `${r.sam}@demo-firma.pl`,
      kind: r.kind,
      kindReason: KIND_REASON[r.kind],
      enabled,
      uac,
      never,
      pwExp: r.never ? null : at(r.pw),
      acctExp: r.acctExp != null ? at(r.acctExp) : null,
      lastLogon: enabled ? NOW - (Math.floor(Math.random() * 5) + 1) * DAY : NOW - 120 * DAY,
      spn: r.spn || 0,
      synced: NOW - 1800,
      created: NOW - 30 * DAY,
    });
  }
});
seedAd();

// ── Powiadomienia katalogu (polityki na OU i na kontach) ────────────────────
// Hasło i ważność konta to dwa niezależne terminy, każdy z własnym włącznikiem
// i progami. Demo jest tylko do odczytu, więc każdy stan musi tu już istnieć:
// OU pilnowane w całości, OU pilnowane tylko pod kątem hasła, OU wyciszone,
// konto z własnymi progami, konto wypisane z OU, oraz OU bez polityki
// (Księgowość) — tam konta milczą.
const insPolicy = db.prepare(`
  INSERT INTO ad_notify_policies
    (scope, target, enabled, notify_password, password_days, notify_account, account_days,
     muted_until, notify_recipients, created_at, updated_at)
  VALUES
    (@scope, @target, @enabled, @notifyPw, @pwDays, @notifyAcct, @acctDays,
     @muted, @recipients, @created, @updated)
`);
const POLICIES = [
  // Konta serwisowe: hasło pilnowane z zapasem, ważność konta nieistotna (te konta
  // nie mają daty końca), osobny adres zespołu.
  { scope: "ou", target: OU.SVC, enabled: 1, notifyPw: 1, pwDays: "7,14,30", notifyAcct: 0, acctDays: null, muted: null, recipients: "it-ops@demo-firma.pl" },
  // IT: oba terminy, oba na progach globalnych (NULL = dziedziczy z Ustawień).
  { scope: "ou", target: OU.IT, enabled: 1, notifyPw: 1, pwDays: null, notifyAcct: 1, acctDays: null, muted: null, recipients: null },
  // Sprzedaż: umowy na czas określony — konto pilnowane z dużym wyprzedzeniem,
  // hasło zostawione użytkownikom. Wyciszone na czas migracji.
  { scope: "ou", target: OU.SP, enabled: 1, notifyPw: 0, pwDays: null, notifyAcct: 1, acctDays: "14,30,60", muted: NOW + 10 * DAY, recipients: "kadry@demo-firma.pl" },
  // Własne, gęstsze progi hasła dla jednego konta — nadpisują politykę OU IT.
  { scope: "account", target: `ad:${AD_GUIDS["pkowalski"]}`, enabled: 1, notifyPw: 1, pwDays: "1,3,7,14", notifyAcct: 1, acctDays: null, muted: null, recipients: "pkowalski@demo-firma.pl" },
  // Konto wypisane z pilnowanego OU: alerty o nim nie przychodzą.
  { scope: "account", target: `ad:${AD_GUIDS["svc-monitoring"]}`, enabled: 0, notifyPw: 0, pwDays: null, notifyAcct: 0, acctDays: null, muted: null, recipients: null },
];
const seedPolicies = db.transaction(() => {
  for (const p of POLICIES) {
    insPolicy.run({ ...p, created: NOW - 15 * DAY, updated: NOW - 3 * DAY });
  }
});
seedPolicies();

// Piotr Kowalski ma 12 dni do wygaśnięcia hasła, więc próg 14-dniowy już poszedł.
db.prepare(
  "UPDATE ad_accounts SET notified_thresholds = ?, last_notified_at = ? WHERE sam_account_name = ?"
).run('["password:14"]', NOW - 2 * DAY, "pkowalski");

// ── Przykładowe ustawienia (wszystkie karty wypełnione, do publicznego demo) ─
// Sekrety szyfrowane tak samo jak w aplikacji (AES-256-GCM, klucz z SETTINGS_KEY
// lub JWT_SECRET, salt "ar-settings-v1"), więc w UI pokazują się jako "••••".
const { scryptSync, createCipheriv, randomBytes } = require("crypto");
function encSecret(plaintext) {
  if (!plaintext) return "";
  const material = process.env.SETTINGS_KEY || process.env.JWT_SECRET;
  if (!material) return plaintext; // bez klucza: zapis jawny, i tak maskowany w UI
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(material, "ar-settings-v1", 32), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["enc:v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
const SECRET_SETTING_KEYS = new Set(["smtp_pass", "azure_client_secret", "ad_bind_password", "webhook_secret", "resend_api_key"]);
const DEMO_SETTINGS = {
  expiring_soon_days: "30",
  urgent_days: "7",
  notifications_enabled: "true",
  notification_recipients: "zespol-it@demo-firma.pl, powiadomienia@demo-firma.pl",
  notification_days: "3,7,21",
  // Katalog ma własne progi, osobne dla hasła i dla ważności konta.
  ad_password_days: "3,7,14",
  ad_account_days: "7,14,30",
  notification_locale: "pl",
  email_provider: "smtp",
  email_from: "Monitoring AdminRedminer <monitoring@demo-firma.pl>",
  smtp_host: "smtp.demo-firma.pl",
  smtp_port: "587",
  smtp_user: "monitoring@demo-firma.pl",
  smtp_pass: "demo-haslo-smtp",
  azure_tenant_id: "11111111-2222-3333-4444-555555555555",
  azure_client_id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  azure_client_secret: "demo-entra-client-secret",
  ad_url: "ldaps://dc01.demo-firma.local:636",
  ad_start_tls: "false",
  ad_bind_dn: "CN=svc-adminredminer,OU=Konta Serwisowe,DC=demo-firma,DC=local",
  ad_bind_password: "demo-haslo-bind",
  ad_base_dn: "DC=demo-firma,DC=local",
  ad_admin_group_dn: "CN=AR-Administratorzy,OU=Grupy,DC=demo-firma,DC=local",
  ad_viewer_group_dn: "CN=AR-Podglad,OU=Grupy,DC=demo-firma,DC=local",
  ad_technical_patterns: "svc-*,svc_*,sa-*,sa_*,srv-*",
  ad_functional_patterns: "recepcja,magazyn,helpdesk,func-*,role-*",
  webhook_enabled: "false",
  webhook_url: "https://hooks.demo-firma.pl/adminredminer",
  webhook_secret: "demo-webhook-secret",
  automation_enabled: "true",
  automation_cron: "0 */6 * * *",
};
const upSetting = db.prepare(
  "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
);
const seedSettings = db.transaction(() => {
  for (const [k, v] of Object.entries(DEMO_SETTINGS)) {
    upSetting.run(k, SECRET_SETTING_KEYS.has(k) ? encSecret(v) : v, NOW);
  }
});
seedSettings();

const n = db.prepare("SELECT COUNT(*) c FROM services").get().c;
const a = db.prepare("SELECT COUNT(*) c FROM audit_log").get().c;
const d = db.prepare("SELECT COUNT(*) c FROM ad_accounts").get().c;
const s = db.prepare("SELECT COUNT(*) c FROM settings").get().c;
const p = db.prepare("SELECT COUNT(*) c FROM ad_notify_policies").get().c;
console.log(`[seed-demo] services=${n} audit=${a} ad_accounts=${d} ad_policies=${p} settings=${s} -> ${DB}`);
db.close();
