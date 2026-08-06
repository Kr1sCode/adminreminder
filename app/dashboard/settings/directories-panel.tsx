"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";
import { useT } from "@/components/i18n-provider";

export interface DirectoryRow {
  id: number;
  type: "ad" | "entra";
  label: string;
  enabled: boolean;
  isPrimary: boolean;
  healthStatus: "ok" | "error" | "unknown";
  healthMessage: string | null;
  healthCheckedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: "ok" | "error" | null;
  lastSyncDetail: string | null;
  url: string | null;
  startTls: boolean;
  allowInsecure: boolean;
  rejectUnauthorized: boolean;
  caCertPath: string | null;
  bindDn: string | null;
  bindPassword: string;
  baseDn: string | null;
  adminGroupDn: string | null;
  viewerGroupDn: string | null;
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string;
  technicalOus: string | null;
  technicalPatterns: string | null;
  functionalOus: string | null;
  functionalPatterns: string | null;
  passwordDays: string | null;
  accountDays: string | null;
  syncCron: string | null;
}

const isMasked = (value: string) => value.length > 0 && [...value].every((c) => c === "•");

function HealthDot({ status }: { status: DirectoryRow["healthStatus"] }) {
  const color =
    status === "ok" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : "bg-muted-foreground/40";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function DirectoriesPanel({ type }: { type: "ad" | "entra" }) {
  const t = useT();
  const [all, setAll] = useState<DirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});

  const rows = all.filter((d) => d.type === type);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/directories");
      if (res.ok) {
        const data = await res.json();
        setAll(data.directories ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selected === "new" || selected === null) {
      setForm({ label: "", startTls: false, allowInsecure: false, rejectUnauthorized: true });
      return;
    }
    const dir = rows.find((d) => d.id === selected);
    if (dir) setForm({ ...dir });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, all]);

  function fv(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function notify(kind: "ok" | "error", text: string) {
    setFeedback({ kind, text });
    if (kind === "ok") setTimeout(() => setFeedback(null), 4000);
  }

  const selectedDir = typeof selected === "number" ? rows.find((d) => d.id === selected) ?? null : null;

  function commonFields() {
    return {
      technicalOus: form.technicalOus || null,
      technicalPatterns: form.technicalPatterns || null,
      functionalOus: form.functionalOus || null,
      functionalPatterns: form.functionalPatterns || null,
      passwordDays: form.passwordDays || null,
      accountDays: form.accountDays || null,
      syncCron: form.syncCron || null,
    };
  }

  async function saveNew() {
    setBusy("save");
    try {
      const body: Record<string, any> = { type, label: form.label, ...commonFields() };
      if (type === "ad") {
        Object.assign(body, {
          url: form.url,
          bindDn: form.bindDn,
          bindPassword: form.bindPassword,
          baseDn: form.baseDn,
          startTls: !!form.startTls,
          allowInsecure: !!form.allowInsecure,
          rejectUnauthorized: form.rejectUnauthorized !== false,
          caCertPath: form.caCertPath || null,
        });
      } else {
        Object.assign(body, { tenantId: form.tenantId, clientId: form.clientId, clientSecret: form.clientSecret });
      }
      const res = await fetch("/api/directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notify("ok", t("dir.addedOk"));
        await load();
        setSelected(data.directory.id);
      } else {
        notify("error", data.error || t("dir.addError"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(id: number) {
    setBusy("save");
    try {
      const body: Record<string, any> = { label: form.label, ...commonFields() };
      if (type === "ad") {
        Object.assign(body, {
          url: form.url,
          bindDn: form.bindDn,
          baseDn: form.baseDn,
          startTls: !!form.startTls,
          allowInsecure: !!form.allowInsecure,
          rejectUnauthorized: form.rejectUnauthorized !== false,
          caCertPath: form.caCertPath || null,
        });
        if (form.bindPassword && !isMasked(form.bindPassword)) body.bindPassword = form.bindPassword;
        if (selectedDir?.isPrimary) {
          Object.assign(body, { adminGroupDn: form.adminGroupDn || null, viewerGroupDn: form.viewerGroupDn || null });
        }
      } else {
        Object.assign(body, { tenantId: form.tenantId, clientId: form.clientId });
        if (form.clientSecret && !isMasked(form.clientSecret)) body.clientSecret = form.clientSecret;
      }
      const res = await fetch(`/api/directories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notify("ok", t("dir.savedOk"));
        await load();
      } else {
        notify("error", data.error || t("dir.saveError"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled(dir: DirectoryRow) {
    setBusy(`enable-${dir.id}`);
    try {
      const res = await fetch(`/api/directories/${dir.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !dir.enabled }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(id: number) {
    setBusy(`test-${id}`);
    try {
      const res = await fetch(`/api/directories/${id}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) notify("ok", data.accountsFound != null ? t("dir.testOkCount", { count: data.accountsFound }) : t("dir.testOk"));
      else notify("error", data.error || t("dir.testError"));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function syncNow(id: number) {
    setBusy(`sync-${id}`);
    try {
      const res = await fetch(`/api/directories/${id}/sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) notify("ok", data.detail || t("dir.savedOk"));
      else notify("error", data.error || t("dir.syncError"));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(dir: DirectoryRow) {
    if (!confirm(t("dir.deleteConfirm", { label: dir.label }))) return;
    setBusy(`delete-${dir.id}`);
    try {
      const res = await fetch(`/api/directories/${dir.id}`, { method: "DELETE" });
      if (res.ok) {
        setSelected(null);
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        notify("error", data.error || t("dir.deleteError"));
      }
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground">{t("dir.loading")}</div>;

  const isNew = selected === "new";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        {rows.map((dir) => (
          <button
            key={dir.id}
            onClick={() => setSelected(dir.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors ${
              selected === dir.id
                ? "border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <HealthDot status={dir.healthStatus} />
            {dir.label}
            {dir.isPrimary && <ShieldCheck className="h-3 w-3 opacity-70" />}
          </button>
        ))}
        <button
          onClick={() => setSelected("new")}
          className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm border border-dashed transition-colors ${
            isNew ? "border-emerald-500 text-emerald-600 dark:text-emerald-400" : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <Plus className="h-3.5 w-3.5" />
          {type === "ad" ? t("dir.addAd") : t("dir.addEntra")}
        </button>
      </div>

      {(selectedDir || isNew) && (
        <div className="space-y-6 max-w-xl">
          {selectedDir && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">{type === "ad" ? t("dir.typeAd") : t("dir.typeEntra")}</Badge>
              {selectedDir.isPrimary && (
                <Badge variant="outline" className="text-xs border-emerald-600 text-emerald-500 dark:text-emerald-400">
                  {t("dir.primary")}
                </Badge>
              )}
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={selectedDir.enabled} onChange={() => toggleEnabled(selectedDir)}
                  disabled={busy !== null} className="h-3.5 w-3.5 accent-emerald-500" />
                {t("dir.enabledLabel")}
              </label>
            </div>
          )}

          <div>
            <Label>{t("dir.labelField")}</Label>
            <Input value={form.label ?? ""} onChange={(e) => fv("label", e.target.value)}
              placeholder={type === "ad" ? t("dir.labelPlaceholderAd") : t("dir.labelPlaceholderEntra")} className="mt-2" />
          </div>

          {type === "ad" ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>{t("dir.url")}</Label>
                  <Input value={form.url ?? ""} onChange={(e) => fv("url", e.target.value)}
                    placeholder="ldaps://dc01.klient.local" className="mt-2 font-mono" />
                </div>
                <div>
                  <Label>{t("dir.baseDn")}</Label>
                  <Input value={form.baseDn ?? ""} onChange={(e) => fv("baseDn", e.target.value)}
                    placeholder="DC=klient,DC=local" className="mt-2 font-mono" />
                </div>
                <div>
                  <Label>{t("dir.bindDn")}</Label>
                  <Input value={form.bindDn ?? ""} onChange={(e) => fv("bindDn", e.target.value)}
                    placeholder="CN=svc-ar,OU=Service Accounts,DC=klient,DC=local" className="mt-2 font-mono" />
                </div>
                <div>
                  <Label>{t("dir.bindPassword")}</Label>
                  <Input type="password" value={form.bindPassword ?? ""} onChange={(e) => fv("bindPassword", e.target.value)} className="mt-2" />
                </div>
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <div className="text-sm font-medium">{t("dir.encryption")}</div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={!!form.startTls} onChange={(e) => setForm((f) => ({ ...f, startTls: e.target.checked }))}
                    className="h-4 w-4 accent-emerald-500" />
                  <span className="text-sm">{t("dir.startTls")}</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={!!form.allowInsecure} onChange={(e) => setForm((f) => ({ ...f, allowInsecure: e.target.checked }))}
                    className="h-4 w-4 accent-emerald-500" />
                  <span className="text-sm">{t("dir.allowInsecure")}</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.rejectUnauthorized !== false} onChange={(e) => setForm((f) => ({ ...f, rejectUnauthorized: e.target.checked }))}
                    className="h-4 w-4 accent-emerald-500" />
                  <span className="text-sm">{t("dir.verifyCert")}</span>
                </label>
                <div>
                  <Label>{t("dir.caPath")}</Label>
                  <Input value={form.caCertPath ?? ""} onChange={(e) => fv("caCertPath", e.target.value)}
                    placeholder="/etc/ssl/certs/klient-ca.pem" className="mt-2 font-mono" />
                </div>
              </div>

              {selectedDir?.isPrimary && (
                <div className="space-y-4 border-t border-border pt-4">
                  <div className="text-sm font-medium">{t("set.ad.loginTitle")}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label>{t("set.ad.adminGroup")}</Label>
                      <Input value={form.adminGroupDn ?? ""} onChange={(e) => fv("adminGroupDn", e.target.value)} className="mt-2 font-mono" />
                    </div>
                    <div>
                      <Label>{t("set.ad.viewerGroup")}</Label>
                      <Input value={form.viewerGroupDn ?? ""} onChange={(e) => fv("viewerGroupDn", e.target.value)} className="mt-2 font-mono" />
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t("dir.tenantId")}</Label>
                <Input value={form.tenantId ?? ""} onChange={(e) => fv("tenantId", e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000" className="mt-2 font-mono" />
              </div>
              <div>
                <Label>{t("dir.clientId")}</Label>
                <Input value={form.clientId ?? ""} onChange={(e) => fv("clientId", e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000" className="mt-2 font-mono" />
              </div>
              <div className="md:col-span-2">
                <Label>{t("dir.clientSecret")}</Label>
                <Input type="password" value={form.clientSecret ?? ""} onChange={(e) => fv("clientSecret", e.target.value)} className="mt-2" />
              </div>
            </div>
          )}

          <div className="space-y-4 border-t border-border pt-4">
            <div className="text-sm font-medium">{t("dir.classification")}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t("dir.techOu")}</Label>
                <Input value={form.technicalOus ?? ""} onChange={(e) => fv("technicalOus", e.target.value)}
                  placeholder="OU=Service Accounts,DC=klient,DC=local" className="mt-2 font-mono" />
              </div>
              <div>
                <Label>{t("dir.techPatterns")}</Label>
                <Input value={form.technicalPatterns ?? ""} onChange={(e) => fv("technicalPatterns", e.target.value)}
                  placeholder="svc-*,svc_*,sa-*,sa_*,srv-*" className="mt-2 font-mono" />
              </div>
              <div>
                <Label>{t("dir.funcOu")}</Label>
                <Input value={form.functionalOus ?? ""} onChange={(e) => fv("functionalOus", e.target.value)}
                  placeholder="OU=Shared,DC=klient,DC=local" className="mt-2 font-mono" />
              </div>
              <div>
                <Label>{t("dir.funcPatterns")}</Label>
                <Input value={form.functionalPatterns ?? ""} onChange={(e) => fv("functionalPatterns", e.target.value)}
                  placeholder="func-*,role-*" className="mt-2 font-mono" />
              </div>
            </div>
          </div>

          <div className="space-y-4 border-t border-border pt-4">
            <div className="text-sm font-medium">{t("dir.notifyDefaults")}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t("dir.pwDays")}</Label>
                <Input value={form.passwordDays ?? ""} onChange={(e) => fv("passwordDays", e.target.value)}
                  placeholder="3,7,14" className="mt-2 font-mono" />
              </div>
              <div>
                <Label>{t("dir.acctDays")}</Label>
                <Input value={form.accountDays ?? ""} onChange={(e) => fv("accountDays", e.target.value)}
                  placeholder="7,14,30" className="mt-2 font-mono" />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <Label>{t("dir.schedule")}</Label>
            <Input value={form.syncCron ?? ""} onChange={(e) => fv("syncCron", e.target.value)}
              placeholder="0 */6 * * *" className="mt-2 font-mono" />
            <p className="text-xs text-muted-foreground mt-1">{t("dir.scheduleHint")}</p>
          </div>

          {selectedDir && (
            <div className="text-xs text-muted-foreground space-y-0.5 border-t border-border pt-4">
              <div className="flex items-center gap-1.5">
                {t("dir.health")}: <HealthDot status={selectedDir.healthStatus} />
                {selectedDir.healthMessage || t("dir.healthUnknown")}
                {selectedDir.healthCheckedAt && ` (${new Date(selectedDir.healthCheckedAt).toLocaleString()})`}
              </div>
              <div>
                {t("dir.lastSync")}:{" "}
                {selectedDir.lastSyncedAt ? new Date(selectedDir.lastSyncedAt).toLocaleString() : t("dir.neverSynced")}
                {selectedDir.lastSyncDetail && ` — ${selectedDir.lastSyncDetail}`}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-1">
            {isNew ? (
              <Button onClick={saveNew} disabled={busy !== null || !form.label} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                {busy === "save" ? t("dir.saving") : t("dir.add")}
              </Button>
            ) : selectedDir ? (
              <>
                <Button onClick={() => saveEdit(selectedDir.id)} disabled={busy !== null} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                  {busy === "save" ? t("dir.saving") : t("dir.save")}
                </Button>
                <Button variant="outline" className="border-border" disabled={busy !== null} onClick={() => testConnection(selectedDir.id)}>
                  {busy === `test-${selectedDir.id}` ? t("dir.testing") : t("dir.test")}
                </Button>
                <Button variant="outline" className="border-border" disabled={busy !== null} onClick={() => syncNow(selectedDir.id)}>
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                  {busy === `sync-${selectedDir.id}` ? t("dir.syncing") : t("dir.sync")}
                </Button>
                {!selectedDir.isPrimary && (
                  <Button variant="ghost" className="text-red-500 dark:text-red-400 hover:text-red-400" disabled={busy !== null} onClick={() => remove(selectedDir)}>
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    {t("dir.delete")}
                  </Button>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {!selectedDir && !isNew && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {type === "ad" ? t("dir.emptyAd") : t("dir.emptyEntra")}{" "}
          {t("dir.emptyHint", { button: type === "ad" ? t("dir.addAd") : t("dir.addEntra") })}
        </p>
      )}

      {feedback && (
        <div className={`flex items-center gap-1.5 text-sm ${feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {feedback.kind === "error" && <AlertTriangle className="h-4 w-4" />}
          {feedback.text}
        </div>
      )}
    </div>
  );
}
