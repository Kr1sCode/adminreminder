"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NavStats, StatPill } from "@/components/nav-stats";
import { NotificationPanel, type NotificationTarget, type NotificationValues, type PanelSide } from "@/components/notification-panel";
import {
  ChevronRight, ChevronDown, RefreshCw, Folder, Search, AlertTriangle, Infinity as InfinityIcon,
  Bell, BellOff,
} from "lucide-react";
import { formatDaysLeft } from "@/lib/cert-checker";
import {
  accountKey, ancestorDns, indexPolicies, resolvePolicy,
  type GlobalDays, type PolicyRow,
} from "@/lib/ad/notify-scope";
import { format } from "date-fns";
import { useT } from "@/components/i18n-provider";

/** Element rendered by the page's footer; the sync time is teleported into it. */
export const AD_FOOTER_SLOT_ID = "ad-footer-slot";

type Kind = "user" | "technical" | "functional";

interface OuNode {
  dn: string;
  name: string;
  children: OuNode[];
  accountCount: number;
  totalAccountCount: number;
  counts: Record<Kind, number>;
  expiringSoon: number;
  expired: number;
}

type Source = "ad" | "entra";

interface Account {
  id: number;
  directoryId: number;
  source: Source;
  objectGuid: string;
  samAccountName: string;
  displayName: string | null;
  userPrincipalName: string | null;
  distinguishedName: string;
  ouPath: string;
  kind: Kind;
  kindReason: string | null;
  enabled: boolean;
  passwordNeverExpires: boolean;
  passwordExpiresAt: string | null;
  accountExpiresAt: string | null;
  lastLogonAt: string | null;
  spnCount: number;
  notifiedThresholds: string[] | null;
  lastNotifiedAt: string | null;
  /** The two expiries are reported apart; the table never blends them. */
  passwordStatus: Status;
  passwordDaysLeft: number | null;
  accountStatus: Status;
  accountDaysLeft: number | null;
}

type Status = "ok" | "expiring" | "expired" | "error" | "never" | "unknown";

interface Policy extends PolicyRow {
  id: number;
}

/** What the bell opens on: an organisational unit, or a single account. */
interface PanelTarget {
  scope: "ou" | "account";
  target: string;
  /** Which forest/tenant this target belongs to — required by PATCH
   *  /api/ad/notifications now that a target string alone isn't unique
   *  across directories (two forests can share an OU's exact DN). */
  directoryId: number;
  item: NotificationTarget;
  /** The password expiry and the account expiry, each with its own thresholds. */
  sides: PanelSide[];
  /** Set for an account, so the panel can name the OU it would inherit from. */
  account?: Account;
}

interface DirectoryOption {
  id: number;
  type: "ad" | "entra";
  label: string;
}

/** Own policy, inherited from an OU, or nothing at all. */
type Mode = "inherit" | "on" | "off";

interface Summary {
  total: number;
  ad: number;
  entra: number;
  byDirectory: Record<number, number>;
  technical: number;
  functional: number;
  disabled: number;
  passwordNeverExpires: number;
  passwordAttention: number;
  accountAttention: number;
  lastSyncedAt: string | null;
}

const KIND_CLASS: Record<Kind, string> = {
  user: "",
  technical: "border-sky-600 text-sky-600 dark:text-sky-400",
  functional: "border-violet-600 text-violet-600 dark:text-violet-400",
};

export function AdClient({
  isAdmin,
  globalDays,
}: {
  isAdmin: boolean;
  /** Fallback thresholds, one list per side (Ustawienia → Active Directory). */
  globalDays: GlobalDays;
}) {
  const t = useT();
  const kindLabel = (k: Kind) =>
    t(k === "technical" ? "adp.kindTechnical" : k === "functional" ? "adp.kindFunctional" : "adp.kindUser");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [tree, setTree] = useState<OuNode[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedOu, setSelectedOu] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<Kind | "all">("all");
  const [directoryFilter, setDirectoryFilter] = useState<number | "all">("all");
  const [directories, setDirectories] = useState<DirectoryOption[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [mode, setMode] = useState<Mode>("inherit");

  // The sync time belongs on the page's bottom edge, and the footer is rendered
  // by the server component above this one. A portal keeps the number here and
  // the position there — the same trick the counters use for the navbar.
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setFooterSlot(document.getElementById(AD_FOOTER_SLOT_ID)), []);

  const lastSyncLabel = (at: string) =>
    t("adp.lastSync", { date: format(new Date(at), "dd.MM.yyyy, HH:mm") });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ad/accounts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("adp.errStatus", { status: res.status }));
      setAccounts(data.accounts);
      setTree(data.tree);
      setSummary(data.summary);
      setExpanded(new Set(data.tree.map((n: OuNode) => n.dn)));
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadPolicies() {
    const res = await fetch("/api/ad/notifications");
    if (!res.ok) return;
    const data = await res.json();
    setPolicies(data.policies);
  }

  async function loadDirectories() {
    const res = await fetch("/api/directories");
    if (!res.ok) return;
    const data = await res.json();
    setDirectories((data.directories ?? []).map((d: any) => ({ id: d.id, type: d.type, label: d.label })));
  }

  useEffect(() => { load(); loadPolicies(); loadDirectories(); }, []);

  /** Syncs every configured AD directory and every Entra tenant; one that isn't
   *  configured at all is skipped, not reported as an error. */
  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);

    const parts: string[] = [];
    const errors: string[] = [];

    for (const [label, url] of [["AD", "/api/ad/sync"], ["Entra ID", "/api/entra/sync"]] as const) {
      try {
        const res = await fetch(url, { method: "POST" });
        const data = await res.json();
        if (res.ok) {
          const ok = (data.outcomes ?? []).filter((o: any) => !o.error);
          if (ok.length) {
            const totals = ok.reduce(
              (acc: any, o: any) => ({
                created: acc.created + (o.result?.created ?? 0),
                updated: acc.updated + (o.result?.updated ?? 0),
                removed: acc.removed + (o.result?.removed ?? 0),
              }),
              { created: 0, updated: 0, removed: 0 }
            );
            parts.push(`${label}: +${totals.created} / ~${totals.updated} / −${totals.removed}`);
          }
          const failed = (data.outcomes ?? []).filter((o: any) => o.error);
          for (const f of failed) errors.push(`${label} (${f.label}): ${f.error}`);
        } else if (!/nie jest skonfigurowana/i.test(data.error || "")) {
          errors.push(`${label}: ${data.error}`);
        }
      } catch (err: any) {
        errors.push(`${label}: ${err.message || err}`);
      }
    }

    // load() clears the error state, so it has to run before the messages are set —
    // otherwise a failed sync leaves the cached list on screen and looks like a success.
    await load();
    await loadDirectories();

    if (errors.length) setError(errors.join(" · "));
    if (parts.length) setNotice(t("adp.syncedNotice", { parts: parts.join(" · ") }));
    else if (!errors.length) setError(t("adp.noneConfigured"));

    setSyncing(false);
  }

  const toggle = (dn: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dn)) next.delete(dn);
      else next.add(dn);
      return next;
    });

  const policyIndex = useMemo(() => indexPolicies(policies), [policies]);

  const ownPolicy = (scope: "ou" | "account", target: string, directoryId: number) =>
    policies.find(
      (p) => p.directoryId === directoryId && p.scope === scope && p.target.toLowerCase() === target.toLowerCase()
    ) ?? null;

  /** What actually governs this account: its own policy, an OU's, or nothing. */
  const effectiveFor = (a: Account) =>
    resolvePolicy(
      { directoryId: a.directoryId, source: a.source, objectGuid: a.objectGuid, ouPath: a.ouPath },
      policyIndex,
      globalDays
    );

  const isMuted = (until: Date | string | null | undefined) =>
    !!until && new Date(until) > new Date();

  /** The panel is reused, not remounted, so the target object is built once here. */
  function openPolicy(
    scope: "ou" | "account",
    target: string,
    name: string,
    identifier: string,
    directoryId: number,
    account?: Account
  ) {
    const own = ownPolicy(scope, target, directoryId);
    setMode(own ? (own.enabled ? "on" : "off") : "inherit");
    setPanel({
      scope,
      target,
      directoryId,
      account,
      sides: [
        {
          key: "password",
          label: t("adp.notif.passwordTitle"),
          hint: t("adp.notif.passwordHint"),
          globalDays: globalDays.password,
          days: own?.passwordDays ?? null,
          enabled: own?.notifyPassword ?? true,
        },
        {
          key: "account",
          label: t("adp.notif.accountTitle"),
          hint: t("adp.notif.accountHint"),
          globalDays: globalDays.account,
          days: own?.accountDays ?? null,
          enabled: own?.notifyAccount ?? true,
        },
      ],
      item: {
        name,
        identifier,
        mutedUntil: own?.mutedUntil ?? null,
        notifyRecipients: own?.notifyRecipients ?? null,
        notifiedThresholds: account?.notifiedThresholds ?? null,
        lastNotifiedAt: account?.lastNotifiedAt ?? null,
      },
    });
  }

  /** "inherit" drops the policy row: the OU above — or nothing — governs again. */
  async function savePolicy(values: NotificationValues): Promise<string | null> {
    if (!panel) return null;

    const password = values.sides.find((s) => s.key === "password");
    const account = values.sides.find((s) => s.key === "account");

    const res = await fetch("/api/ad/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        mode === "inherit"
          ? { directoryId: panel.directoryId, scope: panel.scope, target: panel.target, remove: true }
          : {
              directoryId: panel.directoryId,
              scope: panel.scope,
              target: panel.target,
              enabled: mode === "on",
              notifyPassword: password?.enabled ?? true,
              passwordDays: password?.days ?? null,
              notifyAccount: account?.enabled ?? true,
              accountDays: account?.days ?? null,
              mutedUntil: values.mutedUntil,
              recipients: values.recipients,
            }
      ),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data.error || t("adp.notif.saveError", { status: res.status });

    await Promise.all([loadPolicies(), load()]);
    return null;
  }

  /** An OU selection includes everything beneath it, matching the tree's counters. */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (directoryFilter !== "all" && a.directoryId !== directoryFilter) return false;
      if (selectedOu && a.ouPath !== selectedOu && !a.ouPath.endsWith(`,${selectedOu}`)) return false;
      if (kindFilter !== "all" && a.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        a.samAccountName.toLowerCase().includes(q) ||
        (a.displayName ?? "").toLowerCase().includes(q) ||
        (a.userPrincipalName ?? "").toLowerCase().includes(q)
      );
    });
  }, [accounts, selectedOu, kindFilter, directoryFilter, query]);

  /** Every account under this OU (by DN suffix) shares one directory in
   *  practice — a forest's own DC= suffix makes cross-forest DN collisions on
   *  a real subtree implausible. Used to attach a directoryId to an OU-scope
   *  policy action, which the tree itself (merged across every directory)
   *  doesn't carry per node. */
  function directoryIdForOu(dn: string): number | null {
    const needle = dn.toLowerCase();
    const match = accounts.find((a) => {
      const ou = a.ouPath.toLowerCase();
      return ou === needle || ou.endsWith(`,${needle}`);
    });
    return match?.directoryId ?? null;
  }

  /** One badge for one clock. `never` only ever applies to a password. */
  function statusBadge(a: Account, status: Status, daysLeft: number | null) {
    if (!a.enabled) return <Badge variant="outline" className="text-muted-foreground">{t("adp.disabled")}</Badge>;
    if (status === "never")
      return (
        <Badge variant="outline" className="border-amber-600 text-amber-600 dark:text-amber-400">
          <InfinityIcon className="h-3 w-3 mr-1" /> {t("adp.pwNeverExpires")}
        </Badge>
      );
    if (status === "unknown") return <Badge variant="outline" className="text-muted-foreground">—</Badge>;
    if (status === "expired") return <Badge className="status-expired border">{formatDaysLeft(daysLeft)}</Badge>;
    if (status === "expiring") return <Badge className="status-expiring border">{formatDaysLeft(daysLeft)}</Badge>;
    return <Badge className="status-ok border">{formatDaysLeft(daysLeft)}</Badge>;
  }

  /** The bell in an OU row: off, on, muted, or explicitly silenced. Hidden
   *  (as a plain icon, not a button) when the OU somehow has no accounts to
   *  derive a directoryId from — shouldn't happen, the tree only shows OUs
   *  that have some. */
  function ouBell(node: OuNode) {
    const directoryId = directoryIdForOu(node.dn);
    const own = directoryId != null ? ownPolicy("ou", node.dn, directoryId) : null;
    const muted = isMuted(own?.mutedUntil);
    const watches = own?.enabled && (own.notifyPassword || own.notifyAccount);

    const icon =
      watches && muted ? <BellOff className="h-3.5 w-3.5 text-amber-500" /> :
      watches ? <Bell className="h-3.5 w-3.5 text-emerald-500" fill="currentColor" /> :
      own ? <BellOff className="h-3.5 w-3.5 text-muted-foreground" /> :
      <Bell className="h-3.5 w-3.5 text-muted-foreground opacity-40" />;

    const sides = own
      ? [own.notifyPassword && t("adp.notif.sidePassword"), own.notifyAccount && t("adp.notif.sideAccount")]
          .filter(Boolean)
          .join(" + ")
      : "";

    if (directoryId == null) return <span className="shrink-0 opacity-40">{icon}</span>;

    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); openPolicy("ou", node.dn, node.name, node.dn, directoryId); }}
        className="shrink-0 hover:opacity-100"
        title={watches ? `${t("adp.notif.bell")}: ${sides}` : t("adp.notif.bell")}
        aria-label={t("adp.notif.bell")}
      >
        {icon}
      </button>
    );
  }

  /** Which of the two expiries a policy actually watches, spelled out for the tooltip. */
  function watching(policy: ReturnType<typeof effectiveFor>): string {
    if (!policy?.enabled) return t("adp.notif.stateNone");
    const on: string[] = [];
    if (policy.password.enabled) on.push(t("adp.notif.sidePassword"));
    if (policy.account.enabled) on.push(t("adp.notif.sideAccount"));
    return on.length > 0 ? on.join(" + ") : t("adp.notif.stateNone");
  }

  /** The bell in an account row. An outline bell means the OU above decides. */
  function accountBell(a: Account) {
    const own = ownPolicy("account", accountKey(a), a.directoryId);
    const effective = effectiveFor(a);
    const muted = isMuted(effective?.mutedUntil);
    const active = !!effective?.enabled && (effective.password.enabled || effective.account.enabled);

    const icon =
      active && muted ? <BellOff className="h-4 w-4 text-amber-500" /> :
      own && !own.enabled ? <BellOff className="h-4 w-4 text-muted-foreground" /> :
      active && own ? <Bell className="h-4 w-4 text-emerald-500" fill="currentColor" /> :
      active ? <Bell className="h-4 w-4 text-emerald-500" /> :
      <Bell className="h-4 w-4 text-muted-foreground opacity-40" />;

    const title =
      muted && active ? `${t("adp.notif.stateMuted")} (${watching(effective)})` :
      own && !own.enabled ? t("adp.notif.stateOff") :
      active && own ? `${t("adp.notif.stateOn")}: ${watching(effective)}` :
      active ? `${t("adp.notif.stateInherited", { ou: effective!.fromTarget })}: ${watching(effective)}` :
      t("adp.notif.stateNone");

    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openPolicy("account", accountKey(a), a.displayName || a.samAccountName, a.userPrincipalName || a.samAccountName, a.directoryId, a)}
        className="h-8 px-2"
        title={title}
        aria-label={t("adp.notif.bell")}
      >
        {icon}
      </Button>
    );
  }

  function renderNode(node: OuNode, depth = 0) {
    const isOpen = expanded.has(node.dn);
    const isSelected = selectedOu === node.dn;

    return (
      <div key={node.dn}>
        <div
          className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer text-sm ${
            isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          }`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setSelectedOu(isSelected ? null : node.dn)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(node.dn); }}
            className={`shrink-0 ${node.children.length === 0 ? "invisible" : ""}`}
            aria-label={isOpen ? t("adp.collapse") : t("adp.expand")}
          >
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>

          <span className="ml-auto flex items-center gap-1.5 shrink-0 pl-2">
            {node.expired > 0 && (
              <span className="text-xs text-red-500 dark:text-red-400 tabular-nums">{node.expired}</span>
            )}
            {node.expiringSoon > 0 && (
              <span className="text-xs text-amber-500 dark:text-amber-400 tabular-nums">{node.expiringSoon}</span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">{node.totalAccountCount}</span>
            {isAdmin && ouBell(node)}
          </span>
        </div>

        {isOpen && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  // Which OU would take over if this account's own policy were dropped. Named in
  // the panel, so "inherit" is never a guess about where the alerts come from.
  const inheritedOu = panel?.account
    ? ancestorDns(panel.account.ouPath)
        .map((dn) => policyIndex.byOu.get(dn.toLowerCase()))
        .find((p): p is Policy => !!p) ?? null
    : null;

  return (
    // Same shape as the dashboard: the page itself does not scroll. Filters and
    // counters keep their height, the directory below takes the rest, and the
    // tree and the table scroll inside their own panes.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <NotificationPanel
        item={panel?.item ?? null}
        globalDays={globalDays.password}
        sides={panel?.sides}
        onClose={() => setPanel(null)}
        onSaved={() => {}}
        onSave={savePolicy}
        showHistory={panel?.scope === "account"}
      >
        <section>
          <Label className="text-sm font-medium">{t("adp.notif.scopeTitle")}</Label>
          <p className="text-xs text-muted-foreground mt-1">
            {panel?.scope === "ou" ? t("adp.notif.scopeOuHint") : t("adp.notif.scopeAccountHint")}
          </p>

          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            className="mt-2 w-full bg-background border border-input rounded-md px-3 py-2 text-sm"
          >
            <option value="inherit">
              {panel?.scope === "ou" ? t("adp.notif.modeInheritOu") : t("adp.notif.modeInheritAccount")}
            </option>
            <option value="on">{t("adp.notif.modeOn")}</option>
            <option value="off">{t("adp.notif.modeOff")}</option>
          </select>

          {mode === "inherit" && panel?.scope === "account" && (
            <p className="text-xs text-muted-foreground mt-2">
              {inheritedOu?.enabled
                ? t("adp.notif.inheritedFrom", { ou: inheritedOu.target })
                : t("adp.notif.silent")}
            </p>
          )}
        </section>
      </NotificationPanel>

      {/* Counters ride in the top bar, as on the dashboard. */}
      {summary && (
        <NavStats>
          <StatPill label={t("adp.stat.accounts")} value={summary.total} title={t("adp.stat.accountsTitle")} />
          <StatPill label={t("adp.stat.technical")} value={summary.technical} color="text-sky-500 dark:text-sky-400" />
          <StatPill label={t("adp.stat.functional")} value={summary.functional} color="text-violet-500 dark:text-violet-400" />
          <StatPill label={t("adp.stat.disabled")} value={summary.disabled} color="text-muted-foreground" />
          <StatPill label={t("adp.stat.pwNeverExpires")} value={summary.passwordNeverExpires} color="text-muted-foreground" title={t("adp.pwNeverExpires")} />
          {/* The two clocks are counted apart — a password the user resets, an
              account someone has to extend — and each shows up only when it has
              something to say. A counter reading zero is not news, and the bar
              has room for the ones that are. */}
          {summary.passwordAttention > 0 && (
            <StatPill label={t("adp.stat.pwExpiring")} value={summary.passwordAttention} color="text-amber-500 dark:text-amber-400" title={t("adp.stat.pwExpiringTitle")} />
          )}
          {summary.accountAttention > 0 && (
            <StatPill label={t("adp.stat.acctExpiring")} value={summary.accountAttention} color="text-red-500 dark:text-red-400" title={t("adp.stat.acctExpiringTitle")} />
          )}
        </NavStats>
      )}

      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t("adp.searchPlaceholder")} className="pl-9" />
        </div>

        {summary && Object.keys(summary.byDirectory).length > 1 && (
          <select
            value={directoryFilter === "all" ? "all" : String(directoryFilter)}
            onChange={(e) => setDirectoryFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="bg-background border border-input rounded-md px-3 py-2 text-sm"
          >
            <option value="all">{t("adp.bothDirs")}</option>
            {directories
              .filter((d) => summary.byDirectory[d.id] > 0)
              .map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
          </select>
        )}

        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as Kind | "all")}
          className="bg-background border border-input rounded-md px-3 py-2 text-sm">
          <option value="all">{t("adp.allTypes")}</option>
          <option value="user">{t("adp.userAccounts")}</option>
          <option value="technical">{t("adp.technicalAccounts")}</option>
          <option value="functional">{t("adp.functionalAccounts")}</option>
        </select>

        {isAdmin && (
          <Button onClick={sync} disabled={syncing} variant="outline" className="border-border">
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? t("adp.syncing") : t("adp.syncDirs")}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 inline mr-1.5" />
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </div>
      )}

      {!loading && accounts.length === 0 && !error && (
        <div className="shrink-0 rounded-xl border border-border bg-card p-10 text-center">
          <p className="text-muted-foreground">
            {t("adp.noAccounts")} {isAdmin ? t("adp.noAccountsAdmin") : t("adp.noAccountsViewer")}
          </p>
        </div>
      )}

      {accounts.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border shrink-0">
              <span className="text-sm font-medium">{t("adp.ouTitle")}</span>
              {selectedOu && (
                <button onClick={() => setSelectedOu(null)}
                  className="text-xs text-muted-foreground hover:text-foreground underline">
                  {t("adp.clear")}
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{tree.map((node) => renderNode(node))}</div>
            <p className="text-[11px] text-muted-foreground px-2 pt-2 border-t border-border mt-1 shrink-0">
              {t("adp.ouLegend")}
            </p>
          </div>

          <div className="min-h-0 overflow-y-auto overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              {/* Pinned while the body scrolls; needs an opaque background or the
                  rows would show through it. */}
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th className="text-left px-5 py-3 font-normal text-muted-foreground">{t("adp.colAccount")}</th>
                  <th className="text-left px-4 py-3 font-normal text-muted-foreground">{t("adp.colType")}</th>
                  <th className="text-left px-4 py-3 font-normal text-muted-foreground">{t("adp.colPassword")}</th>
                  <th className="text-left px-4 py-3 font-normal text-muted-foreground">{t("adp.colAccountExpires")}</th>
                  <th className="text-left px-4 py-3 font-normal text-muted-foreground">{t("adp.colLastLogon")}</th>
                  {isAdmin && <th className="w-12 px-2 py-3"></th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <div className="font-medium flex items-center gap-2">
                        {a.displayName || a.samAccountName}
                        {directories.length > 1 && (
                          <span className="text-[10px] uppercase tracking-wide text-sky-500 dark:text-sky-400 border border-sky-500/40 rounded px-1 max-w-[10rem] truncate">
                            {directories.find((d) => d.id === a.directoryId)?.label ?? (a.source === "entra" ? "Entra" : "AD")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{a.samAccountName}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={KIND_CLASS[a.kind]} title={a.kindReason ?? undefined}>
                        {kindLabel(a.kind)}
                      </Badge>
                      {a.spnCount > 0 && (
                        <span className="ml-2 text-[11px] text-muted-foreground" title={t("adp.spnTitle")}>
                          SPN
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div title={a.passwordExpiresAt ? format(new Date(a.passwordExpiresAt), "dd.MM.yyyy") : undefined}>
                        {statusBadge(a, a.passwordStatus, a.passwordDaysLeft)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div title={a.accountExpiresAt ? format(new Date(a.accountExpiresAt), "dd.MM.yyyy") : undefined}>
                        {statusBadge(a, a.accountStatus, a.accountDaysLeft)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {a.lastLogonAt ? format(new Date(a.lastLogonAt), "dd.MM.yyyy") : "—"}
                    </td>
                    {isAdmin && (
                      <td className="px-2 py-3">
                        <div className="opacity-70 hover:opacity-100">{accountBell(a)}</div>
                      </td>
                    )}
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="px-5 py-10 text-center text-muted-foreground">
                      {t("adp.noMatch")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {footerSlot && summary?.lastSyncedAt && createPortal(
        <span className="truncate" title={lastSyncLabel(summary.lastSyncedAt)}>
          {lastSyncLabel(summary.lastSyncedAt)}
        </span>,
        footerSlot
      )}
    </div>
  );
}
