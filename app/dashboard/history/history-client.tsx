"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { useT } from "@/components/i18n-provider";

interface Entry {
  id: number;
  at: string;
  actorName: string;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  entityName: string | null;
  details: Record<string, unknown> | null;
}

/** Colour only: the wording lives in the dictionaries, keyed by the action. */
const ACTION_TONES: Record<string, string> = {
  "item.create": "text-emerald-500 dark:text-emerald-400",
  "item.update": "text-sky-500 dark:text-sky-400",
  "item.renew": "text-sky-500 dark:text-sky-400",
  "item.delete": "text-red-500 dark:text-red-400",
  "item.check": "text-muted-foreground",
  "item.check_all": "text-muted-foreground",
  "item.track_domain": "text-emerald-500 dark:text-emerald-400",
  "item.notifications": "text-sky-500 dark:text-sky-400",
  "user.create": "text-amber-500 dark:text-amber-400",
  "user.delete": "text-red-500 dark:text-red-400",
  "settings.update": "text-amber-500 dark:text-amber-400",
  "apikey.create": "text-amber-500 dark:text-amber-400",
  "apikey.revoke": "text-red-500 dark:text-red-400",
  "auth.login": "text-muted-foreground",
  "auth.login_failed": "text-red-500 dark:text-red-400",
  "auth.logout": "text-muted-foreground",
  "auth.setup": "text-emerald-500 dark:text-emerald-400",
  "sync.ad": "text-muted-foreground",
  "sync.entra": "text-muted-foreground",
  "sync.azure": "text-muted-foreground",
  "notifications.send": "text-muted-foreground",
};

const ACTIONS = Object.keys(ACTION_TONES);
const ENTITIES = ["service", "user", "settings", "apikey"];

/** Renders `details` without pretending to know its shape. */
function Details({ details }: { details: Record<string, unknown> | null }) {
  if (!details || Object.keys(details).length === 0) return <span className="text-muted-foreground">—</span>;

  const changes = details.zmiany as Record<string, { z: unknown; na: unknown }> | undefined;
  if (changes) {
    return (
      <div className="space-y-0.5">
        {Object.entries(changes).map(([field, { z, na }]) => (
          <div key={field} className="text-xs">
            <span className="font-mono text-muted-foreground">{field}</span>{" "}
            <span className="text-red-500/80 dark:text-red-400/80 line-through">{render(z)}</span>{" "}
            <span className="text-muted-foreground">→</span>{" "}
            <span className="text-emerald-600 dark:text-emerald-400">{render(na)}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {Object.entries(details).map(([key, value]) => (
        <div key={key} className="text-xs">
          <span className="font-mono text-muted-foreground">{key}:</span> <span>{render(value)}</span>
        </div>
      ))}
    </div>
  );
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === "") return "∅";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "∅";
  if (typeof value === "boolean") return value ? "\u2713" : "\u2717";
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function HistoryClient() {
  const t = useT();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [entityType, setEntityType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), actor, action, entityType });
      if (q.trim()) params.set("q", q.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const res = await fetch(`/api/audit?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setEntries(data.entries);
      setActors(data.actors);
      setTotal(data.total);
      setPages(data.pages);
    } finally {
      setLoading(false);
    }
  }, [page, actor, action, entityType, q, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change invalidates the current page number.
  useEffect(() => {
    setPage(1);
  }, [actor, action, entityType, q, from, to]);

  function reset() {
    setQ(""); setActor("all"); setAction("all"); setEntityType("all"); setFrom(""); setTo("");
  }

  const selectClass = "bg-background border border-input rounded-md px-3 py-2 text-sm";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 mb-4 shrink-0">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("hist.searchPlaceholder")} className="pl-9" />
        </div>

        <select value={actor} onChange={(e) => setActor(e.target.value)} className={selectClass}>
          <option value="all">{t("hist.filter.whoAll")}</option>
          {actors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <select value={action} onChange={(e) => setAction(e.target.value)} className={selectClass}>
          <option value="all">{t("hist.filter.whatAll")}</option>
          {ACTIONS.map((value) => (
            <option key={value} value={value}>{t(`hist.action.${value}` as never)}</option>
          ))}
        </select>

        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className={selectClass}>
          <option value="all">{t("hist.filter.whereAll")}</option>
          {ENTITIES.map((value) => (
            <option key={value} value={value}>{t(`hist.entity.${value}` as never)}</option>
          ))}
        </select>

        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" title={t("hist.filter.from")} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" title={t("hist.filter.to")} />

        <Button variant="outline" onClick={reset} className="border-border">{t("common.clear")}</Button>
        <Button variant="outline" onClick={load} disabled={loading} className="border-border">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm table-fixed">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="text-left text-muted-foreground border-b border-border bg-muted/50">
              <th className="py-3 px-5 font-medium w-[13%] whitespace-nowrap">{t("hist.col.when")}</th>
              <th className="py-3 px-5 font-medium w-[13%]">{t("hist.col.who")}</th>
              <th className="py-3 px-5 font-medium w-[18%]">{t("hist.col.what")}</th>
              <th className="py-3 px-5 font-medium w-[10%] hidden lg:table-cell">{t("hist.col.where")}</th>
              <th className="py-3 px-5 font-medium w-[22%]">{t("hist.col.onWhat")}</th>
              <th className="py-3 px-5 font-medium">{t("hist.col.basis")}</th>
                          </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                  {loading ? t("common.loading") : t("hist.empty")}
                </td>
              </tr>
            )}

            {entries.map((entry) => {
              const tone = ACTION_TONES[entry.action] ?? "text-foreground";
              const label = ACTIONS.includes(entry.action) ? t(`hist.action.${entry.action}` as never) : entry.action;
              return (
                <tr key={entry.id} className="hover:bg-muted/50 transition-colors align-top">
                  <td className="px-5 py-3 text-xs font-medium text-foreground/80 whitespace-nowrap">
                    {format(new Date(entry.at), "dd.MM.yyyy, HH:mm:ss")}
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium truncate" title={entry.actorName}>{entry.actorName}</div>
                    {entry.actorRole && (
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{entry.actorRole}</div>
                    )}
                  </td>
                  <td className={`px-5 py-3 font-medium ${tone}`}>{label}</td>
                  <td className="px-5 py-3 hidden lg:table-cell">
                    {entry.entityType ? (
                      <Badge variant="outline" className="text-xs font-medium border-border text-foreground">
                        {ENTITIES.includes(entry.entityType) ? t(`hist.entity.${entry.entityType}` as never) : entry.entityType}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium truncate" title={entry.entityName ?? undefined}>
                      {entry.entityName ?? <span className="text-muted-foreground">—</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3"><Details details={entry.details} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 shrink-0 text-xs text-muted-foreground">
        <span>{total === 0 ? t("hist.noEntries") : t("hist.summary", { total, page, pages })}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="border-border"
            onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="border-border"
            onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages || loading}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
