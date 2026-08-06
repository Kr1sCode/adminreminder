"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Trash2, Plus, Save, SlidersHorizontal, Mail, Cloud, Network, Users, Clock,
  AlertTriangle, CheckCircle2, KeyRound, Webhook, Copy, Check, ShieldCheck,
} from "lucide-react";
import { format } from "date-fns";
import { useEffect } from "react";
import { useT, useI18n } from "@/components/i18n-provider";
import { DirectoriesPanel } from "./directories-panel";

/** Mirrors isMasked() in lib/settings.ts: echoing an all-mask-char value back means "unchanged". */
const MASK_CHAR = "•";
const isMasked = (value: string) => value.length > 0 && [...value].every((c) => c === MASK_CHAR);

type User = {
  id: number;
  username: string;
  role: "admin" | "viewer";
  authSource?: "local" | "ad";
  mfaEnabled?: boolean;
  mfaRequired?: boolean;
  createdAt: string | Date;
};

interface Props {
  initialSettings: Record<string, string>;
  initialUsers: User[];
  currentAdminId: number;
}

type Feedback = { kind: "ok" | "error"; text: string } | null;

type LicenseStatus = {
  active: boolean;
  customer: string | null;
  maxItems: number | null;
  expiresAt: string | null;
  freeLimit: number;
  currentCount: number;
  limit: number;
};


const SETTING_KEYS = [
  "expiring_soon_days", "urgent_days",
  "notifications_enabled", "notification_recipients", "notification_days", "notification_locale",
  "email_provider", "email_from", "resend_api_key",
  "smtp_host", "smtp_port", "smtp_user", "smtp_pass",
  "azure_tenant_id", "azure_client_id", "azure_client_secret",
  "ad_url", "ad_start_tls", "ad_allow_insecure", "ad_tls_reject_unauthorized",
  "ad_ca_cert_path", "ad_bind_dn", "ad_bind_password", "ad_base_dn", "ad_timeout_ms",
  "ad_admin_group_dn", "ad_viewer_group_dn",
  "ad_technical_ous", "ad_technical_patterns", "ad_functional_ous", "ad_functional_patterns",
  "ad_password_days", "ad_account_days",
  "webhook_enabled", "webhook_url", "webhook_secret",
];

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revoked: boolean;
  createdAt: string | Date;
}

/**
 * These three live at module scope on purpose. Defined inside SettingsClient they
 * were a fresh component type on every render, so React unmounted and remounted
 * their subtree — which cost SecretInput its focus after each keystroke.
 */
type Getter = (key: string, fallback?: string) => string;
type Setter = (key: string, value: string) => void;
type Translate = ReturnType<typeof useT>;

/** A secret field shows the mask when stored; sending it back leaves it untouched. */
function SecretInput({
  k, placeholder, get, set, t,
}: { k: string; placeholder?: string; get: Getter; set: Setter; t: Translate }) {
  return (
    <>
      <Input
        type="password"
        value={get(k)}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        className="mt-2 font-mono"
      />
      <p className="text-xs text-muted-foreground mt-1">
        {isMasked(get(k)) ? t("set.secretStored") : t("set.secretWillEncrypt")}
      </p>
    </>
  );
}

function Checkbox({
  k, label, get, set,
}: { k: string; label: string; get: Getter; set: Setter }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={get(k) === "true"}
        onChange={(e) => set(k, e.target.checked ? "true" : "false")}
        className="h-4 w-4 accent-emerald-500"
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}

function SaveBar({
  label, saving, feedback, onSave, t,
}: {
  label?: string;
  saving: boolean;
  feedback: { kind: string; text: string } | null;
  onSave: () => void;
  t: Translate;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <Button onClick={onSave} disabled={saving} className="bg-emerald-500 hover:bg-emerald-600 text-black">
        <Save className="h-4 w-4 mr-2" />
        {saving ? t("set.saving") : (label ?? t("set.save"))}
      </Button>
      {feedback && (
        <span
          className={`flex items-center gap-1.5 text-sm ${
            feedback.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {feedback.kind === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {feedback.text}
        </span>
      )}
    </div>
  );
}

export function SettingsClient({ initialSettings, initialUsers, currentAdminId }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [tab, setTab] = useState("ogolne");
  const [settings, setSettings] = useState(initialSettings);
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [newUser, setNewUser] = useState({ username: "", password: "", role: "viewer" as "admin" | "viewer" });
  const [creatingUser, setCreatingUser] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);

  // Two-factor: self-enrolment modal (QR + confirmation code) for this admin.
  const [mfaSetup, setMfaSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<ApiKeyRow | null>(null);

  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);

  // AD watchdog: cached status from lib/ad/health.ts, refreshed in the
  // background by the scheduler every 5 min — this just polls that cache.
  const [adHealth, setAdHealth] = useState<{ status: "ok" | "error"; message: string; checkedAt: number } | null>(null);

  // ── Automatyzacja (wbudowany harmonogram) ──────────────────────────────────
  type AutoState = {
    enabled: boolean; cron: string; valid: boolean; error: string | null; timezone: string;
    nextRuns: number[]; lastRunAt: number | null; lastStatus: string | null; lastDetail: string | null;
  };
  type AutoMode = "interval" | "daily" | "weekly" | "advanced";
  const [auto, setAuto] = useState<AutoState | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoMode, setAutoMode] = useState<AutoMode>("interval");
  const [autoIntervalHours, setAutoIntervalHours] = useState(6);
  const [autoMinute, setAutoMinute] = useState(0);
  const [autoHour, setAutoHour] = useState(8);
  const [autoWeekdays, setAutoWeekdays] = useState<number[]>([1, 2, 3, 4, 5]); // cron dow: 0=Nd..6=So
  const [autoCronRaw, setAutoCronRaw] = useState("0 */6 * * *");
  const [autoPreview, setAutoPreview] = useState<{ valid: boolean; error: string | null; nextRuns: number[] }>({ valid: true, error: null, nextRuns: [] });
  const [autoSaving, setAutoSaving] = useState(false);

  // Open the tab named in the query string, e.g. ?tab=powiadomienia
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    if (tabParam) setTab(tabParam);
    loadApiKeys();
    loadAutomation();
    loadLicense();
    loadAdHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the AD tab is open, poll the cached watchdog status so the light
  // catches up with the scheduler's background checks without a reload.
  useEffect(() => {
    if (tab !== "ad") return;
    const handle = setInterval(loadAdHealth, 30_000);
    return () => clearInterval(handle);
  }, [tab]);

  // Canonical cron expression derived from the builder inputs.
  const autoCron = useMemo(() => {
    const m = Math.min(59, Math.max(0, autoMinute || 0));
    const h = Math.min(23, Math.max(0, autoHour || 0));
    if (autoMode === "interval") return `${m} */${autoIntervalHours} * * *`;
    if (autoMode === "daily") return `${m} ${h} * * *`;
    if (autoMode === "weekly") {
      const days = [...autoWeekdays].sort((a, b) => a - b);
      return `${m} ${h} * * ${days.length ? days.join(",") : "*"}`;
    }
    return autoCronRaw.trim();
  }, [autoMode, autoMinute, autoHour, autoIntervalHours, autoWeekdays, autoCronRaw]);

  // Live preview: validity + next runs, computed on the server (single cron impl).
  useEffect(() => {
    if (tab !== "automatyzacja") return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/settings/automation?preview=${encodeURIComponent(autoCron)}`);
        if (res.ok) setAutoPreview(await res.json());
      } catch { /* ignoruj */ }
    }, 300);
    return () => clearTimeout(handle);
  }, [autoCron, tab]);

  async function loadAutomation() {
    try {
      const res = await fetch("/api/settings/automation");
      if (!res.ok) return;
      const data: AutoState = await res.json();
      setAuto(data);
      setAutoEnabled(data.enabled);
      cronToForm(data.cron);
    } catch { /* ignoruj */ }
  }

  /** Best-effort parse of a stored cron back into a builder mode. */
  function cronToForm(cron: string) {
    const p = cron.trim().split(/\s+/);
    if (p.length === 5) {
      const [mm, hh, dom, mon, dow] = p;
      const m = parseInt(mm, 10);
      if (dom === "*" && mon === "*" && Number.isFinite(m)) {
        if (/^\*\/\d+$/.test(hh) && dow === "*") {
          setAutoMode("interval"); setAutoMinute(m); setAutoIntervalHours(parseInt(hh.slice(2), 10) || 6); return;
        }
        if (/^\d+$/.test(hh)) {
          const h = parseInt(hh, 10);
          if (dow === "*") { setAutoMode("daily"); setAutoMinute(m); setAutoHour(h); return; }
          if (/^[0-7](,[0-7])*$/.test(dow)) {
            setAutoMode("weekly"); setAutoMinute(m); setAutoHour(h);
            setAutoWeekdays([...new Set(dow.split(",").map((x) => { const n = parseInt(x, 10); return n === 7 ? 0 : n; }))]);
            return;
          }
        }
      }
    }
    setAutoMode("advanced"); setAutoCronRaw(cron);
  }

  function toggleWeekday(n: number) {
    setAutoWeekdays((w) => (w.includes(n) ? w.filter((x) => x !== n) : [...w, n]));
  }

  function fmtTs(ts: number): string {
    return new Date(ts).toLocaleString(locale, {
      timeZone: auto?.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  async function saveAutomation() {
    if (autoMode === "weekly" && autoWeekdays.length === 0) { notify("error", t("set.auto.weeklyNeedDay")); return; }
    setAutoSaving(true);
    try {
      const res = await fetch("/api/settings/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: autoEnabled, cron: autoCron }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAuto(data); notify("ok", t("set.saved")); }
      else notify("error", data.error || t("set.saveError"));
    } catch { notify("error", t("set.connError")); }
    finally { setAutoSaving(false); }
  }

  async function runAutomationNow() {
    setBusy("auto-run");
    try {
      const res = await fetch("/api/settings/automation/run", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAuto(data); notify("ok", data.detail || t("set.saved"), 7000); }
      else notify("error", data.error || t("set.actionError", { status: res.status }), 9000);
    } finally { setBusy(null); }
  }

  const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first, cron numbering (0=Sun)
  const dowLabels = t("set.auto.dowShort").split(",");
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const hhmm = (h: number, m: number) => `${pad2(h)}:${pad2(m)}`;
  function setTimeFromStr(v: string) {
    const [h, m] = v.split(":").map((x) => parseInt(x, 10));
    if (Number.isFinite(h)) setAutoHour(h);
    if (Number.isFinite(m)) setAutoMinute(m);
  }
  const MODE_LABELS: Record<AutoMode, string> = {
    interval: t("set.auto.modeInterval"),
    daily: t("set.auto.modeDaily"),
    weekly: t("set.auto.modeWeekly"),
    advanced: t("set.auto.modeAdvanced"),
  };



  async function loadApiKeys() {
    try {
      const res = await fetch("/api/api-keys");
      if (res.ok) setApiKeys((await res.json()).keys);
    } catch { /* ignoruj */ }
  }

  async function createApiKey() {
    setBusy("apikey-create");
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();
      if (res.ok) {
        setFreshToken(data.token);
        setNewKeyName("");
        await loadApiKeys();
      } else {
        notify("error", data.error || t("set.api.createError"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function confirmDeleteKey() {
    if (!keyToDelete) return;
    const target = keyToDelete;
    setKeyToDelete(null);
    const res = await fetch(`/api/api-keys/${target.id}`, { method: "DELETE" });
    if (res.ok) {
      setApiKeys((k) => k.filter((x) => x.id !== target.id));
      notify("ok", t("set.api.keyDeleted", { name: target.name }));
    } else {
      notify("error", t("set.api.keyDeleteError"));
    }
  }

  const set = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }));
  const get = (key: string, fallback = "") => settings[key] ?? fallback;

  async function loadLicense() {
    try {
      const res = await fetch("/api/settings/license");
      if (res.ok) setLicense(await res.json());
    } catch { /* ignoruj */ }
  }

  async function loadAdHealth() {
    try {
      const res = await fetch("/api/ad/health");
      if (res.ok) setAdHealth((await res.json()).health);
    } catch { /* ignoruj */ }
  }

  async function submitLicenseKey(key: string) {
    setLicenseBusy(true);
    try {
      const res = await fetch("/api/settings/license", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (res.ok) {
        setLicense(data);
        setLicenseKeyInput("");
        notify("ok", key ? t("set.license.saved") : t("set.license.removed"));
      } else {
        notify("error", data.error || t("set.license.saveError"));
      }
    } catch (e: any) {
      notify("error", e.message || t("set.license.saveError"));
    } finally {
      setLicenseBusy(false);
    }
  }

  // Errors stay on screen until the next action replaces or clears them —
  // a transient success toast is fine to auto-dismiss, a connection failure
  // that goes away on its own reads as "fixed" when nothing changed.
  function notify(kind: "ok" | "error", text: string, ms = 4000) {
    setFeedback({ kind, text });
    if (kind === "ok") setTimeout(() => setFeedback(null), ms);
  }

  async function saveSettings(extra: Record<string, string> = {}) {
    setSaving(true);
    const payload: Record<string, string> = { ...extra };
    for (const key of SETTING_KEYS) {
      if (!(key in extra) && settings[key] !== undefined) payload[key] = settings[key];
    }

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        if (data.settings) setSettings(data.settings);
        notify("ok", t("set.saved"));
      } else {
        notify("error", data.error || t("set.saveError"));
      }
    } catch {
      notify("error", t("set.connError"));
    } finally {
      setSaving(false);
    }
  }

  /** Runs an action endpoint and reports the outcome inline. */
  async function runAction(
    id: string,
    url: string,
    describe: (data: any) => string
  ) {
    setBusy(id);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) notify("ok", describe(data), 7000);
      else notify("error", data.error || t("set.actionError", { status: res.status }), 9000);
    } catch (err: any) {
      notify("error", t("set.connErrorMsg", { msg: err.message || err }));
    } finally {
      setBusy(null);
    }
  }

  async function createUser() {
    if (!newUser.username || !newUser.password) return;
    setCreatingUser(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUser),
      });
      const data = await res.json();
      if (res.ok) {
        setUsers([...users, data.user]);
        setNewUser({ username: "", password: "", role: "viewer" });
        notify("ok", t("set.users.created"));
      } else {
        notify("error", data.error || t("set.users.createError"));
      }
    } catch {
      notify("error", t("set.connError"));
    } finally {
      setCreatingUser(false);
    }
  }

  async function reloadUsers() {
    const res = await fetch("/api/users");
    if (res.ok) setUsers(await res.json());
  }

  async function toggleMfaRequired(u: User, required: boolean) {
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaRequired: required }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await reloadUsers();
      notify("ok", required ? t("set.users.mfaRequiredOn", { name: u.username }) : t("set.users.mfaRequiredOff", { name: u.username }));
    } else {
      notify("error", data.error || t("set.users.mfaChangeError"));
    }
  }

  async function resetUserMfa(u: User) {
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetMfa: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await reloadUsers();
      notify("ok", t("set.users.mfaResetDone", { name: u.username }));
    } else {
      notify("error", data.error || t("set.users.mfaResetError"));
    }
  }

  async function startSelfMfa() {
    setMfaBusy(true);
    try {
      const res = await fetch("/api/mfa/enroll", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setMfaSetup({ qr: data.qr, secret: data.secret });
        setMfaCode("");
      } else {
        notify("error", data.error || t("set.users.mfaStartError"));
      }
    } finally {
      setMfaBusy(false);
    }
  }

  async function confirmSelfMfa() {
    setMfaBusy(true);
    try {
      const res = await fetch("/api/mfa/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: mfaCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMfaSetup(null);
        setMfaCode("");
        await reloadUsers();
        notify("ok", t("set.users.mfaEnabledSelf"));
      } else {
        notify("error", data.error || t("set.users.badCode"));
      }
    } finally {
      setMfaBusy(false);
    }
  }

  async function confirmDeleteUser() {
    if (!userToDelete) return;
    const target = userToDelete;
    setUserToDelete(null);

    const res = await fetch(`/api/users/${target.id}`, { method: "DELETE" });
    if (res.ok) {
      setUsers(users.filter((u) => u.id !== target.id));
      notify("ok", t("set.users.deleted", { name: target.username }));
    } else {
      const data = await res.json().catch(() => ({}));
      notify("error", data.error || t("set.users.deleteError"));
    }
  }

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="ogolne" icon={<SlidersHorizontal className="h-4 w-4" />}>{t("set.tab.general")}</TabsTrigger>
          <TabsTrigger value="powiadomienia" icon={<Mail className="h-4 w-4" />}>{t("set.tab.notifications")}</TabsTrigger>
          <TabsTrigger value="entra" icon={<Cloud className="h-4 w-4" />}>{t("set.tab.entra")}</TabsTrigger>
          <TabsTrigger value="ad" icon={<Network className="h-4 w-4" />}>{t("set.tab.ad")}</TabsTrigger>
          <TabsTrigger value="uzytkownicy" icon={<Users className="h-4 w-4" />}>{t("set.tab.users")}</TabsTrigger>
          <TabsTrigger value="api" icon={<KeyRound className="h-4 w-4" />}>{t("set.tab.api")}</TabsTrigger>
          <TabsTrigger value="automatyzacja" icon={<Clock className="h-4 w-4" />}>{t("set.tab.automation")}</TabsTrigger>
          <TabsTrigger value="licencja" icon={<ShieldCheck className="h-4 w-4" />}>{t("set.tab.license")}</TabsTrigger>
        </TabsList>

        {/* ---------------- Ogólne ---------------- */}
        <TabsContent value="ogolne">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.gen.title")}</CardTitle>
              <CardDescription>{t("set.gen.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label>{t("set.gen.soonLabel")}</Label>
                  <Input type="number" value={get("expiring_soon_days", "30")}
                    onChange={(e) => set("expiring_soon_days", e.target.value)} className="mt-2" />
                  <p className="text-xs text-muted-foreground mt-1">{t("set.gen.soonHint")}</p>
                </div>
                <div>
                  <Label>{t("set.gen.urgentLabel")}</Label>
                  <Input type="number" value={get("urgent_days", "7")}
                    onChange={(e) => set("urgent_days", e.target.value)} className="mt-2" />
                  <p className="text-xs text-muted-foreground mt-1">{t("set.gen.urgentHint")}</p>
                </div>
              </div>
              <SaveBar label={t("set.gen.saveThresholds")} saving={saving} feedback={feedback} onSave={() => saveSettings()} t={t} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Powiadomienia ---------------- */}
        <TabsContent value="powiadomienia">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.notif.title")}</CardTitle>
              <CardDescription>{t("set.notif.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Checkbox k="notifications_enabled" label={t("set.notif.enable")} get={get} set={set} />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label>{t("set.notif.recipients")}</Label>
                  <Input value={get("notification_recipients")}
                    onChange={(e) => set("notification_recipients", e.target.value)}
                    placeholder="admin@twojafirma.pl,devops@twojafirma.pl" className="mt-2" />
                </div>
                <div>
                  <Label>{t("set.notif.daysLabel")}</Label>
                  <Input value={get("notification_days", "3,7,21")}
                    onChange={(e) => set("notification_days", e.target.value)} className="mt-2" />
                  <p className="text-xs text-muted-foreground mt-1">{t("set.notif.daysHint")}</p>
                </div>
              </div>

              <div>
                <Label>{t("set.notif.langLabel")}</Label>
                <div className="flex gap-2 mt-2">
                  {(["pl", "en"] as const).map((code) => {
                    const active = get("notification_locale", "pl") === code;
                    return (
                      <Button
                        key={code}
                        type="button"
                        variant={active ? "default" : "outline"}
                        onClick={() => set("notification_locale", code)}
                        className={active ? "bg-emerald-500 hover:bg-emerald-600 text-black" : "border-border"}
                      >
                        {code === "pl" ? "🇵🇱 Polski" : "🇬🇧 English"}
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">{t("set.notif.langHint")}</p>
              </div>

              <div>
                <Label>{t("set.notif.providerLabel")}</Label>
                <select value={get("email_provider", "resend")}
                  onChange={(e) => set("email_provider", e.target.value)}
                  className="mt-2 w-full bg-background border border-input rounded-md px-3 py-2 text-sm">
                  <option value="resend">{t("set.notif.providerResend")}</option>
                  <option value="smtp">{t("set.notif.providerSmtp")}</option>
                </select>
              </div>


              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label>{t("set.notif.fromLabel")}</Label>
                  <Input value={get("email_from")} onChange={(e) => set("email_from", e.target.value)}
                    placeholder="AR <ar@adminreminder.local>" className="mt-2" />
                </div>

                {get("email_provider", "resend") === "resend" && (
                  <div>
                    <Label>Resend API Key</Label>
                    <SecretInput k="resend_api_key" placeholder="re_xxxxxxxxxxxxxxxx" get={get} set={set} t={t} />
                  </div>
                )}
                {get("email_provider", "resend") === "smtp" && (
                  <>
                    <div>
                      <Label>SMTP Host</Label>
                      <Input value={get("smtp_host")} onChange={(e) => set("smtp_host", e.target.value)}
                        placeholder="mail.twojafirma.pl" className="mt-2" />
                    </div>
                    <div>
                      <Label>SMTP Port</Label>
                      <Input value={get("smtp_port", "587")} onChange={(e) => set("smtp_port", e.target.value)} className="mt-2" />
                    </div>
                    <div>
                      <Label>{t("set.notif.smtpUser")}</Label>
                      <Input value={get("smtp_user")} onChange={(e) => set("smtp_user", e.target.value)} className="mt-2" />
                    </div>
                    <div>
                      <Label>{t("set.notif.smtpPass")}</Label>
                      <SecretInput k="smtp_pass" get={get} set={set} t={t} />
                    </div>
                  </>
                )}
              </div>

              <div className="flex flex-wrap gap-3 pt-2">
                <Button onClick={() => saveSettings()} disabled={saving} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? t("set.saving") : t("set.notif.saveEmail")}
                </Button>
                <Button variant="outline" className="border-border" disabled={busy !== null}
                  onClick={() => runAction("test-mail", "/api/notifications/test", () => t("set.notif.testSent"))}>
                  {busy === "test-mail" ? t("set.sending") : t("set.notif.sendTest")}
                </Button>
                <Button variant="outline" className="border-border" disabled={busy !== null}
                  onClick={() => runAction("send-now", "/api/notifications/send",
                    (d) => t("set.notif.sentResult", { recipients: d.recipients, sent: d.sent }))}>
                  {busy === "send-now" ? t("set.sending") : t("set.notif.sendNow")}
                </Button>
              </div>

              {feedback && (
                <div className={`text-sm ${feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {feedback.text}
                </div>
              )}

              <div className="text-xs text-muted-foreground border-t border-border pt-4">
                {t("set.notif.footer")}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Entra ID ---------------- */}
        <TabsContent value="entra">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.entra.title")}</CardTitle>
              <CardDescription>{t("set.entra.desc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DirectoriesPanel type="entra" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Active Directory ---------------- */}
        <TabsContent value="ad">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.ad.connTitle")}</CardTitle>
              <CardDescription>{t("set.ad.connDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DirectoriesPanel type="ad" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- API i webhooki ---------------- */}
        <TabsContent value="api">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> {t("set.api.keysTitle")}</CardTitle>
              <CardDescription>{t("set.api.keysDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[220px]">
                  <Label>{t("set.api.newKeyName")}</Label>
                  <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="np. Agent AI / n8n / monitoring" className="mt-2" />
                </div>
                <Button onClick={createApiKey} disabled={busy === "apikey-create"} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                  <Plus className="h-4 w-4 mr-2" /> {t("set.api.createKey")}
                </Button>
              </div>

              {freshToken && (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
                  <div className="text-sm font-medium mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {t("set.api.freshToken")}
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-background border border-border rounded px-3 py-2 text-xs break-all font-mono">{freshToken}</code>
                    <Button size="sm" variant="outline" className="border-border shrink-0"
                      onClick={() => { navigator.clipboard.writeText(freshToken); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <button onClick={() => setFreshToken(null)} className="text-xs text-muted-foreground underline mt-2">{t("set.api.hide")}</button>
                </div>
              )}

              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.api.colName")}</th>
                      <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.api.colPrefix")}</th>
                      <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.api.colLastUsed")}</th>
                      <th className="w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.length === 0 && (
                      <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">{t("set.api.noKeys")}</td></tr>
                    )}
                    {apiKeys.map((k) => (
                      <tr key={k.id} className="border-t border-border hover:bg-muted/40">
                        <td className="py-2.5 px-4 font-medium">{k.name}</td>
                        <td className="py-2.5 px-4 font-mono text-xs text-muted-foreground">{k.prefix}…</td>
                        <td className="py-2.5 px-4 text-xs text-muted-foreground">
                          {k.lastUsedAt ? format(new Date(k.lastUsedAt), "dd.MM.yyyy HH:mm") : t("set.api.never")}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setKeyToDelete(k)}
                            className="h-7 text-red-500 dark:text-red-400 hover:text-red-400">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="text-xs text-muted-foreground border-t border-border pt-4 space-y-1">
                <div className="font-medium text-foreground">{t("set.api.exampleTitle")}</div>
                <code className="block bg-muted p-2 rounded break-all">
                  curl -H &quot;Authorization: Bearer ar_...&quot; https://twoja-domena.pl/api/v1/items?expiring=30
                </code>
                <div>{t("set.api.available")}</div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Webhook className="h-5 w-5" /> {t("set.api.webhookTitle")}</CardTitle>
              <CardDescription>{t("set.api.webhookDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Checkbox k="webhook_enabled" label={t("set.api.webhookEnable")} get={get} set={set} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <Label>{t("set.api.webhookUrl")}</Label>
                  <Input value={get("webhook_url")} onChange={(e) => set("webhook_url", e.target.value)}
                    placeholder="https://twoj-system/webhook" className="mt-2 font-mono" />
                </div>
                <div className="md:col-span-2">
                  <Label>{t("set.api.webhookSecret")}</Label>
                  <SecretInput k="webhook_secret" get={get} set={set} t={t} />
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => saveSettings()} disabled={saving} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                  <Save className="h-4 w-4 mr-2" /> {saving ? t("set.saving") : t("set.api.saveWebhook")}
                </Button>
                <Button variant="outline" className="border-border" disabled={busy !== null}
                  onClick={() => runAction("webhook-test", "/api/notifications/webhook-test",
                    (d) => d.sent ? t("set.api.webhookDelivered", { status: d.status }) : t("set.api.webhookFailed", { error: d.error || d.skipped }))}>
                  {busy === "webhook-test" ? t("set.sending") : t("set.api.testWebhook")}
                </Button>
              </div>
              {feedback && (
                <div className={`text-sm ${feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {feedback.text}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Użytkownicy ---------------- */}
        <TabsContent value="uzytkownicy">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.users.title")}</CardTitle>
              <CardDescription>{t("set.users.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="border border-border rounded-lg p-4 bg-muted/30">
                <div className="font-medium mb-3 text-foreground">{t("set.users.addTitle")}</div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                  <Input placeholder={t("set.users.phName")} value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} className="md:col-span-2" />
                  <Input type="password" placeholder={t("set.users.phPass")} value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="md:col-span-2" />
                  <select value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value as "admin" | "viewer" })}
                    className="bg-background border border-input rounded-md px-3 text-sm">
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                  </select>
                </div>
                <Button onClick={createUser} disabled={creatingUser} className="mt-3" size="sm">
                  <Plus className="h-4 w-4 mr-2" /> {t("set.users.create")}
                </Button>
              </div>

              <div>
                <div className="text-sm text-muted-foreground mb-2">{t("set.users.current")}</div>
                <div className="rounded-lg border border-border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.users.colUser")}</th>
                        <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.users.colSource")}</th>
                        <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.users.colRole")}</th>
                        <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.users.colMfa")}</th>
                        <th className="text-left py-2 px-4 font-normal text-muted-foreground">{t("set.users.colCreated")}</th>
                        <th className="w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id} className="border-t border-border hover:bg-muted/50">
                          <td className="py-2.5 px-4 font-medium">{u.username}</td>
                          <td className="py-2.5 px-4">
                            <Badge variant="outline" className="text-xs">
                              {u.authSource === "ad" ? t("set.users.srcAd") : t("set.users.srcLocal")}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-4">
                            <Badge variant="outline" className={u.role === "admin" ? "border-emerald-600 text-emerald-500 dark:text-emerald-400" : ""}>
                              {u.role}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              {u.mfaEnabled ? (
                                <Badge variant="outline" className="border-emerald-600 text-emerald-500 dark:text-emerald-400 text-xs">{t("set.users.mfaActive")}</Badge>
                              ) : u.mfaRequired ? (
                                <Badge variant="outline" className="border-amber-600 text-amber-500 dark:text-amber-400 text-xs">{t("set.users.mfaRequired")}</Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs text-muted-foreground">{t("set.users.mfaDisabled")}</Badge>
                              )}
                              <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={!!u.mfaRequired}
                                  onChange={(e) => toggleMfaRequired(u, e.target.checked)}
                                  className="h-3.5 w-3.5 accent-emerald-500"
                                />
                                {t("set.users.mfaRequire")}
                              </label>
                              {u.id === currentAdminId && !u.mfaEnabled && (
                                <Button variant="outline" size="sm" className="h-6 text-xs border-border" onClick={startSelfMfa} disabled={mfaBusy}>
                                  {t("set.users.mfaConfigure")}
                                </Button>
                              )}
                              {u.mfaEnabled && (
                                <Button variant="ghost" size="sm" className="h-6 text-xs text-amber-500 hover:text-amber-400" onClick={() => resetUserMfa(u)}>
                                  {t("set.users.mfaReset")}
                                </Button>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-xs text-muted-foreground">
                            {format(new Date(u.createdAt), "dd.MM.yyyy")}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            {u.id !== currentAdminId && (
                              <Button variant="ghost" size="sm" onClick={() => setUserToDelete(u)}
                                className="h-7 text-red-500 dark:text-red-400 hover:text-red-400">
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">{t("set.users.cantDeleteSelf")}</p>
              </div>

              {feedback && (
                <div className={`text-sm ${feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {feedback.text}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Automatyzacja ---------------- */}
        <TabsContent value="automatyzacja">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle>{t("set.auto.title")}</CardTitle>
              <CardDescription>{t("set.auto.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 text-sm">
              {/* Włącznik */}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoEnabled}
                  onChange={(e) => setAutoEnabled(e.target.checked)}
                  className="h-5 w-5 mt-0.5 accent-emerald-500"
                />
                <span>
                  <span className="font-medium flex items-center gap-2">
                    {t("set.auto.enable")}
                    <Badge className={autoEnabled ? "bg-emerald-500 text-black" : "bg-muted text-muted-foreground"}>
                      {autoEnabled ? t("set.auto.statusOn") : t("set.auto.statusOff")}
                    </Badge>
                  </span>
                  <span className="block text-muted-foreground text-xs mt-1">{t("set.auto.enableHint")}</span>
                </span>
              </label>

              {/* Tryb */}
              <div>
                <Label className="mb-2 block">{t("set.auto.mode")}</Label>
                <div className="flex flex-wrap gap-2">
                  {(["interval", "daily", "weekly", "advanced"] as AutoMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setAutoMode(mode)}
                      className={`px-3 py-1.5 rounded-md border text-sm transition ${
                        autoMode === mode
                          ? "border-emerald-500 bg-emerald-500/10 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ustawienia trybu */}
              <div className="rounded-lg border border-border p-4 space-y-4 bg-muted/30">
                {autoMode === "interval" && (
                  <div className="flex flex-wrap items-end gap-4">
                    <div>
                      <Label className="mb-1 block">{t("set.auto.everyHours")}</Label>
                      <select
                        value={autoIntervalHours}
                        onChange={(e) => setAutoIntervalHours(parseInt(e.target.value, 10))}
                        className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                      >
                        {[1, 2, 3, 4, 6, 8, 12].map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="mb-1 block">{t("set.auto.minuteOfHour")}</Label>
                      <Input
                        type="number"
                        min={0}
                        max={59}
                        value={autoMinute}
                        onChange={(e) => setAutoMinute(Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                        className="w-24"
                      />
                    </div>
                  </div>
                )}

                {autoMode === "daily" && (
                  <div>
                    <Label className="mb-1 block">{t("set.auto.time")}</Label>
                    <input
                      type="time"
                      value={hhmm(autoHour, autoMinute)}
                      onChange={(e) => setTimeFromStr(e.target.value)}
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    />
                  </div>
                )}

                {autoMode === "weekly" && (
                  <div className="space-y-3">
                    <div>
                      <Label className="mb-1 block">{t("set.auto.time")}</Label>
                      <input
                        type="time"
                        value={hhmm(autoHour, autoMinute)}
                        onChange={(e) => setTimeFromStr(e.target.value)}
                        className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block">{t("set.auto.weekdaysLabel")}</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {DOW_ORDER.map((n, i) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => toggleWeekday(n)}
                            className={`h-9 w-12 rounded-md border text-sm ${
                              autoWeekdays.includes(n)
                                ? "border-emerald-500 bg-emerald-500/15 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {dowLabels[i]}
                          </button>
                        ))}
                      </div>
                      {autoWeekdays.length === 0 && (
                        <p className="text-xs text-red-500 mt-1">{t("set.auto.weeklyNeedDay")}</p>
                      )}
                    </div>
                  </div>
                )}

                {autoMode === "advanced" && (
                  <div>
                    <Label className="mb-1 block">{t("set.auto.cronExpr")}</Label>
                    <Input
                      value={autoCronRaw}
                      onChange={(e) => setAutoCronRaw(e.target.value)}
                      className="font-mono"
                      placeholder="0 */6 * * *"
                    />
                    <p className="text-xs text-muted-foreground mt-1">{t("set.auto.cronHelp")}</p>
                  </div>
                )}
              </div>

              {/* Podgląd */}
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("set.auto.resultCron")}</p>
                    <code className="text-sm font-mono">{autoCron}</code>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("set.auto.timezone")}: <span className="font-medium text-foreground">{auto?.timezone ?? "—"}</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t("set.auto.nextRuns")}</p>
                  {autoPreview.valid && autoPreview.nextRuns.length > 0 ? (
                    <ul className="text-sm space-y-0.5">
                      {autoPreview.nextRuns.map((ts) => (
                        <li key={ts} className="flex items-center gap-2">
                          <Clock className="h-3.5 w-3.5 text-emerald-500" />
                          {fmtTs(ts)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-red-500 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" />
                      {t("set.auto.cronInvalid")}
                    </p>
                  )}
                </div>
              </div>

              {/* Ostatnie uruchomienie */}
              <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                <span>{t("set.auto.lastRun")}:</span>
                {auto?.lastRunAt ? (
                  <span className="flex items-center gap-1.5">
                    {auto.lastStatus === "error" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    <span className="text-foreground">{fmtTs(auto.lastRunAt)}</span>
                    {auto.lastDetail && <span>— {auto.lastDetail}</span>}
                  </span>
                ) : (
                  <span>{t("set.auto.never")}</span>
                )}
              </div>

              {/* Akcje */}
              <div className="flex items-center gap-3 pt-1 flex-wrap">
                <Button
                  onClick={saveAutomation}
                  disabled={autoSaving || (autoMode === "weekly" && autoWeekdays.length === 0) || !autoPreview.valid}
                  className="bg-emerald-500 hover:bg-emerald-600 text-black"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {autoSaving ? t("set.saving") : t("set.auto.save")}
                </Button>
                <Button variant="outline" onClick={runAutomationNow} disabled={busy === "auto-run"}>
                  <Clock className="h-4 w-4 mr-2" />
                  {busy === "auto-run" ? t("set.auto.running") : t("set.auto.runNow")}
                </Button>
                {feedback && (
                  <span
                    className={`flex items-center gap-1.5 text-sm ${
                      feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {feedback.kind === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    {feedback.text}
                  </span>
                )}
              </div>

              {/* Zewnętrzny cron (opcjonalnie) */}
              <details className="rounded-lg border border-border p-4">
                <summary className="cursor-pointer font-medium">{t("set.auto.external")}</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-muted-foreground text-xs">{t("set.auto.externalHint")}</p>
                  <div>
                    <p className="font-medium mb-1">{t("set.auto.cronEndpoint")}</p>
                    <code className="block bg-muted p-2 rounded text-xs break-all">GET /api/cron/check-and-notify</code>
                  </div>
                  <div>
                    <p className="font-medium mb-1">{t("set.auto.authHeader")}</p>
                    <code className="block bg-muted p-2 rounded text-xs">Authorization: Bearer {"{CRON_SECRET}"}</code>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t("set.auto.hint3prefix")}{" "}
                    <code>0 */6 * * * curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; https://twoja-domena.pl/api/cron/check-and-notify</code>
                  </p>
                </div>
              </details>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- Licencja ---------------- */}
        <TabsContent value="licencja">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> {t("set.license.title")}</CardTitle>
              <CardDescription>{t("set.license.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {license && (
                <div className={`rounded-lg border p-4 ${license.active ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
                  {license.active ? (
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" /> {t("set.license.activeTitle")}
                      </div>
                      <div className="text-muted-foreground">
                        {t("set.license.customer")}: <span className="text-foreground font-medium">{license.customer}</span>
                      </div>
                      {license.expiresAt && (
                        <div className="text-muted-foreground">
                          {t("set.license.expiresLabel")}: <span className="text-foreground font-medium">{format(new Date(license.expiresAt), "dd.MM.yyyy")}</span>
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        {t("set.license.usageLabel")}: <span className="text-foreground font-medium">{license.currentCount} / {license.maxItems?.toLocaleString()}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" /> {t("set.license.freeTitle")}
                      </div>
                      <div className="text-muted-foreground">
                        {t("set.license.usageLabel")}: <span className="text-foreground font-medium">{license.currentCount} / {license.freeLimit}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <Label>{t("set.license.keyLabel")}</Label>
                <textarea
                  value={licenseKeyInput}
                  onChange={(e) => setLicenseKeyInput(e.target.value)}
                  placeholder={t("set.license.keyPh")}
                  rows={3}
                  className="mt-2 w-full bg-background border border-input rounded-md px-3 py-2 text-xs font-mono resize-y"
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => submitLicenseKey(licenseKeyInput)}
                  disabled={licenseBusy || !licenseKeyInput.trim()}
                  className="bg-emerald-500 hover:bg-emerald-600 text-black"
                >
                  <Save className="h-4 w-4 mr-2" /> {licenseBusy ? t("set.saving") : t("set.license.save")}
                </Button>
                {license?.active && (
                  <Button variant="outline" className="border-border" disabled={licenseBusy} onClick={() => submitLicenseKey("")}>
                    {t("set.license.remove")}
                  </Button>
                )}
              </div>

              {feedback && (
                <div className={`text-sm ${feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {feedback.text}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground mt-8">{t("set.footer")}</p>

      <Dialog open={keyToDelete !== null} onOpenChange={(open) => { if (!open) setKeyToDelete(null); }}>
        <DialogContent className="sm:max-w-[420px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">{t("set.dlg.deleteKeyTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("set.dlg.deleteKeyDesc", { name: keyToDelete?.name ?? "", prefix: keyToDelete?.prefix ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setKeyToDelete(null)}>{t("set.cancel")}</Button>
            <Button type="button" onClick={confirmDeleteKey} className="bg-red-500 hover:bg-red-600 text-white">{t("set.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mfaSetup !== null} onOpenChange={(open) => { if (!open) { setMfaSetup(null); setMfaCode(""); } }}>
        <DialogContent className="sm:max-w-[420px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">{t("set.mfa.dlgTitle")}</DialogTitle>
            <DialogDescription>{t("set.mfa.dlgDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {mfaSetup?.qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mfaSetup.qr} alt="Kod QR MFA" width={200} height={200} className="rounded-lg border border-border bg-white p-2" />
            )}
            <div className="text-center">
              <div className="text-xs text-muted-foreground">{t("set.mfa.manualKey")}</div>
              <code className="text-xs font-mono break-all">{mfaSetup?.secret}</code>
            </div>
            <Input
              inputMode="numeric"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              className="h-11 w-40 tracking-[0.4em] text-center text-lg font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMfaSetup(null); setMfaCode(""); }} className="border-border">
              {t("set.cancel")}
            </Button>
            <Button onClick={confirmSelfMfa} disabled={mfaBusy || mfaCode.length !== 6} className="bg-emerald-500 hover:bg-emerald-600 text-black">
              {t("set.mfa.enable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={userToDelete !== null} onOpenChange={(open) => { if (!open) setUserToDelete(null); }}>
        <DialogContent className="sm:max-w-[420px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">{t("set.dlg.deleteUserTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("set.dlg.deleteUserDesc", { name: userToDelete?.username ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setUserToDelete(null)}>{t("set.cancel")}</Button>
            <Button type="button" onClick={confirmDeleteUser} className="bg-red-500 hover:bg-red-600 text-white">
              {t("set.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
