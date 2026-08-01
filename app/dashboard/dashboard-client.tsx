"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle, 
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Edit2,
  CalendarPlus,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Bell,
  BellOff,
  Download,
  Sparkles,
  X
} from "lucide-react";
import { NotificationPanel } from "@/components/notification-panel";
import { NavStats, StatPill } from "@/components/nav-stats";
import { computeStats, itemStatus } from "@/lib/dashboard-stats";
import { csvFilename, toCsv } from "@/lib/csv";
import { useT } from "@/components/i18n-provider";
import { format } from "date-fns";

// Supported types (must match backend). Labels come from the dictionaries,
// keyed by value, so the table follows the interface language while the CSV
// export and the notification e-mails keep the server-rendered typeLabel.
const ITEM_TYPES = [
  { value: 'https_cert', autoCheck: true },
  { value: 'tls_endpoint', autoCheck: true },
  { value: 'adcs', autoCheck: true },
  { value: 'warranty', autoCheck: false },
  { value: 'azure_secret', autoCheck: false },
  { value: 'azure_cert', autoCheck: false },
  { value: 'api_token', autoCheck: false },
  { value: 'license', autoCheck: false },
  { value: 'domain', autoCheck: true },
  { value: 'other', autoCheck: false },
] as const;

type ItemTypeValue = typeof ITEM_TYPES[number]['value'];

type Item = {
  id: number;
  type: ItemTypeValue;
  name: string;
  identifier: string;
  port: number;
  owner: string | null;
  notes: string | null;
  customData: Record<string, string> | null;
  renewalUrl: string | null;
  expiryDate: string | Date | null;
  lastCheckedAt: string | Date | null;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
  computedStatus: "ok" | "expiring" | "expired" | "error";
  daysLeft: number | null;
  typeLabel?: string;
  /** Set when this row also watches the registration of the domain behind it. */
  domainName?: string | null;
  domainExpiryDate?: string | Date | null;
  domainStatus?: "ok" | "expiring" | "expired" | "error" | null;
  domainDaysLeft?: number | null;
  domainLastCheckError?: string | null;
  notificationDays?: string | null;
  mutedUntil?: string | Date | null;
  notifyRecipients?: string | null;
  notifiedThresholds?: string[] | null;
  lastNotifiedAt?: string | Date | null;
};

type SortKey = "name" | "type" | "identifier" | "owner" | "cert" | "domain" | "lastChecked";
type SortDir = "asc" | "desc";

const SORT_KEYS: Record<SortKey, string> = {
  name: "col.name",
  type: "col.type",
  identifier: "col.identifier",
  owner: "col.owner",
  cert: "col.cert",
  domain: "col.domain",
  lastChecked: "col.lastChecked",
};

/** Sort value for a column: a string to collate, a number to order, or null. */
function sortValue(item: Item, key: SortKey): string | number | null {
  switch (key) {
    case "name": return item.name;
    case "type": return item.type;
    case "identifier": return item.identifier;
    case "owner": return item.owner;
    // Domain-only rows keep their registration date in expiryDate, so they have
    // nothing to contribute to the certificate column and vice versa.
    case "cert": return item.type === "domain" ? null : item.daysLeft;
    case "domain": return item.type === "domain" ? item.daysLeft : item.domainDaysLeft ?? null;
    case "lastChecked": return item.lastCheckedAt ? new Date(item.lastCheckedAt).getTime() : null;
  }
}

/**
 * Rows without a value for the active column sort last in both directions:
 * an item with no owner is not "before" every named owner, it is simply absent.
 */
function compareBy(key: SortKey, dir: SortDir) {
  const sign = dir === "asc" ? 1 : -1;
  return (a: Item, b: Item) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);

    if (va === null || va === "") return vb === null || vb === "" ? 0 : 1;
    if (vb === null || vb === "") return -1;

    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
    return String(va).localeCompare(String(vb), "pl", { sensitivity: "base" }) * sign;
  };
}

interface DashboardClientProps {
  initialItems: Item[];
  stats: {
    total: number;
    expired: number;
    expiring: number;
    valid: number;
  };
  currentUser: { id: number; username: string; role: "admin" | "viewer" };
  /** Global notification thresholds, inherited by items that define none. */
  globalNotificationDays?: number[];
  /** Below this many days an expiry is urgent, not merely approaching. */
  urgentDays?: number;
}

export function DashboardClient({
  initialItems,
  stats: initialStats,
  currentUser,
  globalNotificationDays = [3, 7, 21],
  urgentDays = 7,
}: DashboardClientProps) {
  const t = useT();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [stats, setStats] = useState(initialStats);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "expiring" | "expired" | "error">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | ItemTypeValue>("all");
  // Nearest certificate expiry first: the reason to open this page at all.
  const [sortKey, setSortKey] = useState<SortKey>("cert");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [loadingCheck, setLoadingCheck] = useState<number | null>(null);
  const [isCheckingAll, setIsCheckingAll] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);

  // Free-tier usage banner. Only admins can add items, so only they need to
  // know they're about to hit the wall — a viewer fetching this would just
  // get a 403 (the route is admin-only) for no reason.
  const [license, setLicense] = useState<{ active: boolean; freeLimit: number } | null>(null);
  useEffect(() => {
    if (currentUser.role !== "admin") return;
    fetch("/api/settings/license")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setLicense({ active: data.active, freeLimit: data.freeLimit }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Signed release check (lib/update-check.ts) — cached server-side, this
  // call is cheap. Dismissal is per-version and purely client-side: a later
  // release re-shows the banner even if an older one was dismissed.
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; notesUrl: string } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    if (currentUser.role !== "admin") return;
    fetch("/api/update-check")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.available) return;
        setUpdateInfo({ latestVersion: data.latestVersion, notesUrl: data.notesUrl });
        setUpdateDismissed(localStorage.getItem("ar_update_dismissed") === data.latestVersion);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissUpdate() {
    if (updateInfo) localStorage.setItem("ar_update_dismissed", updateInfo.latestVersion);
    setUpdateDismissed(true);
  }
  const [savingItem, setSavingItem] = useState(false);
  const [renewingId, setRenewingId] = useState<number | null>(null);
  const [notifyItem, setNotifyItem] = useState<Item | null>(null);

  // "Also track the other half of this website" — a certificate and its domain
  // registration are almost always wanted together. The server derives the
  // counterpart's name, so there is nothing to type here.
  const [alsoTrack, setAlsoTrack] = useState(false);

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // Form state - generalized
  const [form, setForm] = useState({
    type: 'https_cert' as ItemTypeValue,
    name: "",
    identifier: "",
    port: "443",
    owner: "",
    notes: "",
    renewalUrl: "",
    expiryDate: "",
    // tls_endpoint only: role label, TLS SNI override, pinned SHA-256 fingerprint.
    role: "",
    sni: "",
    pin: "",
  });

  const filteredItems = items
    .filter((item) => {
      const q = search.toLowerCase();
      const matchesSearch =
        item.name.toLowerCase().includes(q) ||
        item.identifier.toLowerCase().includes(q) ||
        (item.owner || "").toLowerCase().includes(q) ||
        (item.notes || "").toLowerCase().includes(q);
      // Match on the item's folded status, so a filtered view shows exactly as
      // many rows as the header pill counts. A cert-fine/domain-expiring page
      // still folds to "expiring", so it is not hidden.
      const matchesStatus =
        statusFilter === "all" ||
        itemStatus(item.computedStatus, item.domainStatus) === statusFilter;
      const matchesType = typeFilter === "all" || item.type === typeFilter;
      return matchesSearch && matchesStatus && matchesType;
    })
    .sort(compareBy(sortKey, sortDir));

  function updateStats(newItems: Item[]) {
    // One row = one count — mirrors app/dashboard/page.tsx.
    setStats(computeStats(newItems));
  }

  async function refreshItems() {
    try {
      const res = await fetch("/api/services");
      if (res.ok) {
        const data = await res.json();
        setItems(data);
        updateStats(data);
      } else {
        console.error("refreshItems failed", res.status);
        const data = await res.json().catch(() => ({}));
        console.error(data);
      }
    } catch (e) {
      console.error("refreshItems error", e);
    }
  }

  // Driven by the type table above, so a new checkable type needs one edit, not two.
  const canAutoCheck = (item: Item) =>
    ITEM_TYPES.find((entry) => entry.value === item.type)?.autoCheck ?? false;

  // The bell is filled (not outlined) when the item overrides the global
  // thresholds with its own — i.e. "use global thresholds" is unchecked.
  const hasCustomThresholds = (item: Item) =>
    !!item.notificationDays &&
    item.notificationDays.split(",").some((d) => Number.isFinite(parseInt(d.trim(), 10)));

  async function checkOne(itemId: number) {
    setLoadingCheck(itemId);
    try {
      const res = await fetch(`/api/services/${itemId}/check`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("err.check"));
      } else {
        await refreshItems();
      }
    } finally {
      setLoadingCheck(null);
    }
  }

  async function checkAll() {
    setIsCheckingAll(true);
    try {
      const res = await fetch("/api/services/check-all", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("err.checkAll"));
      } else {
        await refreshItems();
      }
    } finally {
      setIsCheckingAll(false);
    }
  }

  async function performDelete(id: number) {
    // Optimistic update (remove from UI right away)
    const prevItems = items;
    const filtered = items.filter((i) => Number(i.id) !== Number(id));
    setItems(filtered);
    updateStats(filtered);

    setDeletingId(id);

    try {
      const res = await fetch(`/api/services/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));

      console.log(`[DELETE] id=${id} status=${res.status}`, data);

      if (res.ok) {
        await refreshItems(); // full sync
      } else {
        setItems(prevItems);
        updateStats(prevItems);
        alert(data.error || `Błąd DELETE (status ${res.status})`);
      }
    } catch (err: any) {
      setItems(prevItems);
      updateStats(prevItems);
      console.error("Delete exception:", err);
      alert(t("err.deletePrefix", { reason: err.message || String(err) }));
    } finally {
      setDeletingId(null);
    }
  }

  function confirmDelete() {
    if (deleteConfirm !== null) {
      performDelete(deleteConfirm);
      setDeleteConfirm(null);
    }
  }

  function cancelDelete() {
    setDeleteConfirm(null);
  }

  async function renewItem(id: number) {
    const item = items.find(i => i.id === id);
    if (!item || !item.expiryDate || renewingId) return;
    if (canAutoCheck(item)) return;

    const current = new Date(item.expiryDate);
    const newExpiry = new Date(current);
    newExpiry.setFullYear(newExpiry.getFullYear() + 1);

    // Renewal overwrites the stored expiry date and the old value is gone, so a
    // stray click must not silently push the item a year into the future.
    const when = (d: Date) => format(d, "dd.MM.yyyy");
    const confirmed = window.confirm(
      t("dlg.renewConfirm", { name: item.name, from: when(current), to: when(newExpiry) })
    );
    if (!confirmed) return;

    setRenewingId(id);
    try {
      const res = await fetch(`/api/services/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryDate: newExpiry.toISOString() }),
      });

      if (res.ok) {
        await refreshItems();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("err.renew"));
      }
    } finally {
      setRenewingId(null);
    }
  }

  function resetCompanion() {
    setAlsoTrack(false);
  }

  function openAdd() {
    setEditingItem(null);
    resetCompanion();
    setForm({
      type: 'https_cert',
      name: "",
      identifier: "",
      port: "443",
      owner: "",
      notes: "",
      renewalUrl: "",
      expiryDate: "",
      role: "",
      sni: "",
      pin: "",
    });
    setShowAddDialog(true);
  }

  function openEdit(item: Item) {
    setEditingItem(item);
    resetCompanion();
    setForm({
      type: (item.type as ItemTypeValue) || 'https_cert',
      name: item.name,
      identifier: item.identifier,
      port: item.port?.toString() || "443",
      owner: item.owner || "",
      notes: item.notes || "",
      renewalUrl: item.renewalUrl || "",
      expiryDate: item.expiryDate ? new Date(item.expiryDate).toISOString().split('T')[0] : "",
      role: item.customData?.role || "",
      sni: item.customData?.sni || "",
      pin: item.customData?.pin || "",
    });
    setShowAddDialog(true);
  }

  async function saveItem(e: React.FormEvent) {
    e.preventDefault();
    // A slow request leaves the dialog open and the button live; without this a
    // second click submits the same item again.
    if (savingItem) return;
    setSavingItem(true);

    const payload: any = {
      type: form.type,
      name: form.name.trim(),
      identifier: form.identifier.trim(),
      port: parseInt(form.port) || 443,
      owner: form.owner.trim() || null,
      notes: form.notes.trim() || null,
      renewalUrl: form.renewalUrl.trim() || null,
      expiryDate: form.expiryDate ? new Date(form.expiryDate).toISOString() : null,
      // Only tls_endpoint carries this; other types send an empty object, which
      // the server sanitises away.
      customData:
        form.type === 'tls_endpoint'
          ? { role: form.role.trim(), sni: form.sni.trim(), pin: form.pin.trim() }
          : {},
    };

    const wantsCompanion = canOfferCompanion && alsoTrack;

    try {
      if (editingItem) {
        const res = await fetch(`/api/services/${editingItem.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(err.error || t("err.save"));
          return;
        }

        // The counterpart is created against the saved row, so it inherits the
        // identifier as it now stands rather than as it was opened.
        if (wantsCompanion) {
          const companionRes = await fetch(`/api/services/${editingItem.id}/companion`, {
            method: "POST",
          });
          if (!companionRes.ok) {
            const err = await companionRes.json().catch(() => ({}));
            alert(t("err.companion", { reason: err.error || companionRes.status }));
          }
        }
      } else {
        const res = await fetch("/api/services", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, alsoTrack: wantsCompanion }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(err.error || t("err.save"));
          return;
        }
        // The primary row exists either way; only the counterpart may have failed.
        const data = await res.json().catch(() => ({}));
        if (data.companionError) alert(`Pozycja dodana. ${data.companionError}`);
      }

      setShowAddDialog(false);
      await refreshItems();
    } finally {
      setSavingItem(false);
    }
  }

  const STATUS_LABELS: Record<string, string> = {
    ok: t("status.ok"),
    expiring: t("status.expiring"),
    expired: t("status.expired"),
    error: t("status.error"),
  };

  const isoDate = (value: string | Date | null | undefined) =>
    value ? new Date(value).toISOString().slice(0, 10) : "";

  /**
   * Exports what the operator is looking at: the current filter and sort order,
   * not the whole table. Exporting rows they cannot see would be surprising.
   * Built in the browser from data already loaded — no round trip.
   */
  function exportCsv() {
    // Headers follow the interface language: the operator downloading the file
    // is the one reading it. The e-mails keep the server-rendered typeLabel.
    const headers = [
      t("csv.name"), t("col.type"), t("col.identifier"), t("dlg.port"), t("col.owner"), t("csv.notes"),
      t("csv.expires"), t("csv.daysLeft"), t("csv.status"),
      t("col.domain"), t("csv.domainPaidUntil"), t("csv.daysLeftDomain"), t("csv.statusDomain"),
      t("col.lastChecked"), t("csv.renewalLink"),
    ];

    const rows = filteredItems.map((item) => {
      const domainOnly = item.type === "domain";
      return [
        item.name,
        t(`type.${item.type}` as never),
        item.identifier,
        item.type === "https_cert" ? item.port : "",
        item.owner ?? "",
        item.notes ?? "",
        domainOnly ? "" : isoDate(item.expiryDate),
        domainOnly ? "" : item.daysLeft ?? "",
        domainOnly ? "" : STATUS_LABELS[item.computedStatus] ?? item.computedStatus,
        domainOnly ? item.identifier : item.domainName ?? "",
        domainOnly ? isoDate(item.expiryDate) : isoDate(item.domainExpiryDate),
        domainOnly ? item.daysLeft ?? "" : item.domainDaysLeft ?? "",
        domainOnly
          ? STATUS_LABELS[item.computedStatus] ?? item.computedStatus
          : item.domainStatus
            ? STATUS_LABELS[item.domainStatus] ?? item.domainStatus
            : "",
        item.lastCheckedAt ? new Date(item.lastCheckedAt).toISOString().slice(0, 19).replace("T", " ") : "nigdy",
        item.renewalUrl ?? "",
      ];
    });

    const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename("ar-pozycje");
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Clicking the active column flips direction; a new column starts ascending. */
  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const SortHeader = ({ column, className = "" }: { column: SortKey; className?: string }) => {
    const active = sortKey === column;
    return (
      <th className={`py-3 px-5 font-medium ${className}`} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors max-w-full"
          title={t("col.sortBy", { name: t(SORT_KEYS[column] as never) })}
        >
          <span className="truncate">{t(SORT_KEYS[column] as never)}</span>
          {active
            ? (sortDir === "asc"
                ? <ArrowUp className="h-3 w-3 flex-shrink-0" />
                : <ArrowDown className="h-3 w-3 flex-shrink-0" />)
            : <ChevronsUpDown className="h-3 w-3 flex-shrink-0 opacity-30" />}
        </button>
      </th>
    );
  };

  /**
   * The column heading already says whether this is the certificate or the
   * domain, so the badge carries only the time. The full sentence lives in the
   * tooltip: spelled out, it overflows the column on a laptop screen.
   */
  /** "za 5 dni" / "in 5 days": the number alone, for the badge. */
  function shortDays(days: number | null): string {
    if (days === null) return t("common.none");
    if (days < 0) return t("exp.agoDays", { n: Math.abs(days) });
    if (days === 0) return t("exp.today");
    if (days === 1) return t("exp.inDay");
    return t("exp.inDays", { n: days });
  }

  /** The full sentence, for the tooltip: a domain is renewed, not reissued. */
  function describe(type: string, days: number | null): string {
    if (days === null) return t("common.none");
    const when = days === 0 ? t("exp.today") : days === 1 ? t("exp.inDay") : t("exp.inDays", { n: days });
    if (type === "domain") {
      return days < 0 ? t("exp.domainUnpaid", { n: Math.abs(days) }) : t("exp.domainRenew", { when });
    }
    return days < 0 ? t("exp.certExpired", { n: Math.abs(days) }) : t("exp.certExpires", { when });
  }

  function getStatusBadge(status: string, daysLeft: number | null, type: string) {
    if (status === "error") return <Badge className="status-error border">{t("dash.statusError")}</Badge>;

    // Inside urgentDays the amber "approaching" colour understates the problem:
    // a week before expiry this needs to read as red, not as a gentle warning.
    const urgent = status === "expiring" && daysLeft !== null && daysLeft <= urgentDays;

    const cls =
      status === "ok" ? "status-ok" : urgent || status === "expired" ? "status-expired" : "status-expiring";

    return (
      <Badge className={`${cls} border max-w-full whitespace-nowrap`} title={describe(type, daysLeft)}>
        {shortDays(daysLeft)}
      </Badge>
    );
  }

  const deleteItem = deleteConfirm !== null ? items.find(i => Number(i.id) === Number(deleteConfirm)) : undefined;
  const selectedTypeConfig = ITEM_TYPES.find((entry) => entry.value === form.type);
  const showPortField = form.type === 'https_cert' || form.type === 'tls_endpoint';
  const companionType: ItemTypeValue | null =
    form.type === 'https_cert' ? 'domain' : form.type === 'domain' ? 'https_cert' : null;

  // Offer domain tracking only where it means something and is not already on.
  const canOfferCompanion = companionType !== null && !editingItem?.domainName;

  return (
    // Fills the height handed down by the page shell; only the table scrolls.
    <div className="flex h-full min-h-0 flex-col">
      {updateInfo && !updateDismissed && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-2 mb-3 text-sm shrink-0">
          <Sparkles className="h-4 w-4 text-emerald-500 shrink-0" />
          <span className="flex-1">
            {t("dash.updateAvailable", { version: updateInfo.latestVersion })}
          </span>
          <a
            href={updateInfo.notesUrl}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-600 dark:text-emerald-400 font-medium hover:underline shrink-0"
          >
            {t("dash.updateViewRelease")}
          </a>
          <button
            onClick={dismissUpdate}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title={t("dash.updateDismiss")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Counters ride in the top bar; the table gets the reclaimed height. */}
      <NavStats>
        <StatPill label={t("stats.all")} value={stats.total} title={t("stats.allTitle")} />
        <StatPill label={t("stats.valid")} value={stats.valid} color="text-emerald-500 dark:text-emerald-400" />
        <StatPill label={t("stats.expiring")} value={stats.expiring} color="text-amber-500 dark:text-amber-400" title={t("stats.expiringTitle")} />
        <StatPill label={t("stats.expired")} value={stats.expired} color="text-red-500 dark:text-red-400" />
      </NavStats>


      {/* Controls */}
      <div className="flex flex-col lg:flex-row gap-3 mb-4 items-stretch lg:items-center justify-between shrink-0">
        <div className="flex flex-1 flex-wrap gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("dash.searchPlaceholder")}
              className="pl-9 h-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            className="bg-background border border-input rounded-md px-3 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-ring"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
          >
            <option value="all">{t("dash.allStatuses")}</option>
            <option value="ok">{t("stats.valid")}</option>
            <option value="expiring">{t("stats.expiringTitle")}</option>
            <option value="expired">{t("stats.expired")}</option>
            <option value="error">{t("dash.statusError")}</option>
          </select>

          <select
            className="bg-background border border-input rounded-md px-3 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-ring"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
          >
            <option value="all">{t("dash.allTypes")}</option>
            {ITEM_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>{t(`type.${entry.value}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={checkAll} 
            disabled={isCheckingAll}
            className="border-border"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isCheckingAll ? "animate-spin" : ""}`} />
            {t("dash.checkAll")}
          </Button>

          <Button 
            variant="outline" 
            onClick={refreshItems} 
            className="border-border"
          >
            {t("dash.refresh")}
          </Button>

          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={filteredItems.length === 0}
            className="border-border"
            title={t("dash.exportTitle")}
          >
            <Download className="h-4 w-4 mr-2" />
            {t("dash.export")}
          </Button>

          {currentUser.role === "admin" && license && !license.active && (
            <a
              href="/dashboard/settings?tab=licencja"
              className="flex items-center text-xs text-muted-foreground hover:text-foreground underline decoration-dotted self-center px-1"
              title={t("dash.freeTierHint")}
            >
              {t("dash.freeTierUsage", { count: items.length, limit: license.freeLimit })}
            </a>
          )}

          {currentUser.role === "admin" && (
            <Button onClick={openAdd} className="bg-emerald-500 hover:bg-emerald-600 text-black font-medium">
              <Plus className="h-4 w-4 mr-2" />
              {t("dash.addItem")}
            </Button>
          )}
        </div>
      </div>

      <NotificationPanel
        item={notifyItem}
        globalDays={globalNotificationDays}
        onClose={() => setNotifyItem(null)}
        onSaved={refreshItems}
      />

      {/* Table */}
      {/* Cells truncate with an ellipsis instead of pushing the table wider, so the
          action buttons never leave the container. overflow-x-auto is a fallback
          for viewports too narrow even for the truncated layout. */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm table-fixed">
          {/* Pinned while the body scrolls; needs an opaque background or the
              rows would show through it. */}
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="text-left text-muted-foreground border-b border-border bg-muted/50">
              {/* Deliberately without a width: in a table-fixed layout any slack is shared
                  out among every column, so hiding a column at a breakpoint would inflate
                  the action column. One unsized column absorbs it all instead. */}
              <SortHeader column="name" />
              <SortHeader column="type" className="hidden lg:table-cell w-[12%]" />
              <SortHeader column="identifier" className="w-[14%]" />
              <SortHeader column="owner" className="hidden xl:table-cell w-[9%]" />
              <SortHeader column="cert" className="w-[13%] whitespace-nowrap" />
              <SortHeader column="domain" className="w-[13%] whitespace-nowrap" />
              <SortHeader column="lastChecked" className="hidden xl:table-cell w-[11%] whitespace-nowrap" />
              <th className="py-3 px-4 w-[11rem]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
                  {t("dash.empty")}
                </td>
              </tr>
            )}

            {filteredItems.map((item) => {
              const isCert = item.type === 'https_cert';
              const isDomainOnly = item.type === 'domain';
              return (
                <tr key={item.id} className="hover:bg-muted/50 transition-colors group">
                  <td className="px-5 py-4">
                    <div className="font-medium truncate" title={item.name}>{item.name}</div>
                    {item.notes && <div className="text-xs text-foreground/70 truncate mt-0.5" title={item.notes}>{item.notes}</div>}
                    {item.renewalUrl && (
                      <a href={item.renewalUrl} target="_blank" className="text-emerald-600 dark:text-emerald-400 text-xs hover:underline">
                        {t("dash.renewalLink")}
                      </a>
                    )}
                  </td>
                  <td className="px-5 py-4 hidden lg:table-cell">
                    <Badge
                      variant="outline"
                      title={t(`type.${item.type}` as never)}
                      className="max-w-full justify-start text-xs font-medium border-border text-foreground"
                    >
                      <span className="min-w-0 truncate">{t(`type.${item.type}` as never)}</span>
                    </Badge>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs font-medium text-foreground">
                    <div className="truncate" title={item.identifier}>
                      {item.identifier}
                      {(isCert || item.type === 'tls_endpoint') && item.port !== 443 && `:${item.port}`}
                    </div>
                    {(item.type === 'tls_endpoint' || item.type === 'adcs') && item.customData?.role && (
                      <div className="text-[10px] font-sans text-muted-foreground mt-0.5 truncate" title={item.customData.role}>
                        {item.customData.role}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm hidden xl:table-cell">
                    <div
                      className={`truncate ${item.owner ? "font-medium text-foreground" : "text-muted-foreground"}`}
                      title={item.owner || undefined}
                    >
                      {item.owner || "—"}
                    </div>
                  </td>
                  {/* A domain-only row keeps its single date in the Domena column;
                      its expiryDate is a registration date, not a certificate. */}
                  <td className="px-5 py-4">
                    {isDomainOnly
                      ? <span className="text-muted-foreground text-xs">—</span>
                      : getStatusBadge(item.computedStatus, item.daysLeft, item.type)}
                  </td>
                  <td className="px-5 py-4">
                    {isDomainOnly ? (
                      getStatusBadge(item.computedStatus, item.daysLeft, "domain")
                    ) : item.domainName ? (
                      <>
                        {getStatusBadge(item.domainStatus ?? "error", item.domainDaysLeft ?? null, "domain")}
                        <div className="text-[10px] font-medium text-foreground/70 mt-1 font-mono truncate" title={item.domainName ?? undefined}>{item.domainName}</div>
                        {item.domainLastCheckError && (
                          <div className="text-red-500 dark:text-red-400 text-[10px] mt-0.5 truncate" title={item.domainLastCheckError ?? undefined}>
                            {item.domainLastCheckError}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-xs hidden xl:table-cell">
                    {item.lastCheckedAt ? (
                      <span className="font-medium text-foreground/80">
                        {format(new Date(item.lastCheckedAt), "dd MMM yyyy, HH:mm")}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("common.never")}</span>
                    )}
                    {item.lastCheckError && (
                      <div className="text-red-500 dark:text-red-400 text-[10px] mt-0.5 truncate" title={item.lastCheckError ?? undefined}>{item.lastCheckError}</div>
                    )}
                  </td>
                  {/* Pinned right: the cell needs its own background or the scrolled
                      columns show through, and it must track the row hover colour. */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100">
                      {/* First in the row, whatever the item type: "Sprawdź" only
                          exists for auto-checkable items, so leaving the bell after
                          it would shift its position between rows. */}
                      {currentUser.role === "admin" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setNotifyItem(item)}
                          className="h-8 px-2 text-muted-foreground hover:text-foreground"
                          title={t("row.notifications")}
                        >
                          {item.mutedUntil && new Date(item.mutedUntil) > new Date()
                            ? <BellOff className="h-4 w-4 text-amber-500" />
                            : <Bell
                                className={`h-4 w-4 ${hasCustomThresholds(item) ? "text-foreground" : ""}`}
                                fill={hasCustomThresholds(item) ? "currentColor" : "none"}
                              />}
                        </Button>
                      )}

                      {canAutoCheck(item) && (
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          onClick={() => checkOne(item.id)}
                          disabled={loadingCheck === item.id}
                          title={t("row.check")}
                          className="h-8 px-2"
                        >
                          {loadingCheck === item.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                        </Button>
                      )}

                      {currentUser.role === "admin" && (
                        <>
                          {/* Only for manually dated items: for certificates and
                              domains the next check would overwrite the value. */}
                          {item.expiryDate && !canAutoCheck(item) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => renewItem(item.id)}
                              disabled={renewingId === item.id}
                              className="h-8 px-2 text-emerald-600 hover:text-emerald-700"
                              title={t("row.renewYear")}
                            >
                              <CalendarPlus className="h-4 w-4" />
                            </Button>
                          )}
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            onClick={() => openEdit(item)}
                            className="h-8 px-2"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            onClick={() => setDeleteConfirm(item.id)}
                            disabled={deletingId === item.id}
                            className="h-8 px-2 text-red-400 hover:text-red-400"
                          >
                            {deletingId === item.id ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-[520px] max-h-[90dvh] overflow-y-auto bg-card border-border text-[15px] leading-relaxed">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">{editingItem ? t("dlg.editTitle") : t("dlg.addTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Możesz śledzić certyfikaty HTTPS (z automatycznym sprawdzaniem), gwarancje, sekrety Azure Graph API, licencje i wiele innych.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={saveItem} className="space-y-4">
            <div>
              <Label>{t("col.type")}</Label>
              <select
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ItemTypeValue })}
              >
                {ITEM_TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>{t(`type.${entry.value}` as never)}</option>
                ))}
              </select>
              {selectedTypeConfig && !selectedTypeConfig.autoCheck && (
                <p className="text-xs text-amber-500 dark:text-amber-400 mt-1">
                  {t("dlg.manualOnly")}
                </p>
              )}
              {form.type === 'domain' && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t("dlg.domainHint")}
                </p>
              )}
            </div>

            <div>
              <Label className="text-sm font-medium text-foreground/90">{t("dlg.name")}</Label>
              <Input 
                required 
                value={form.name} 
                onChange={(e) => setForm({ ...form, name: e.target.value })} 
                placeholder={t("dlg.namePh")} 
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              <div className={showPortField ? "sm:col-span-3" : "sm:col-span-5"}>
                <Label className="text-sm font-medium text-foreground/90">
                  {form.type === 'https_cert' || form.type === 'tls_endpoint' ? t("dlg.hostLabel") :
                   form.type === 'domain' ? t("dlg.domainLabel") :
                   form.type === 'adcs' ? t("dlg.adcsLabel") : t("dlg.identifier")}
                </Label>
                <Input
                  required
                  value={form.identifier}
                  onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                  className={form.type === 'adcs' ? "font-mono text-xs" : undefined}
                  placeholder={
                    form.type === 'https_cert' ? t("dlg.hostPh") :
                    form.type === 'tls_endpoint' ? t("dlg.tlsHostPh") :
                    form.type === 'domain' ? t("dlg.domainPh") :
                    form.type === 'adcs' ? t("dlg.adcsPh") :
                    form.type === 'azure_secret' ? t("dlg.azurePh") :
                    form.type === 'warranty' ? t("dlg.warrantyPh") :
                    t("dlg.otherPh")
                  }
                />
                {form.type === 'adcs' && (
                  <p className="text-xs text-muted-foreground mt-1">{t("dlg.adcsHint")}</p>
                )}
              </div>

              {showPortField && (
                <div className="sm:col-span-2">
                  <Label>{t("dlg.port")}</Label>
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                  />
                </div>
              )}
            </div>

            {form.type === 'tls_endpoint' && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <p className="text-xs text-muted-foreground">{t("dlg.tlsHint")}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-sm font-medium text-foreground/90">{t("dlg.tlsRole")}</Label>
                    <Input
                      value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value })}
                      placeholder={t("dlg.tlsRolePh")}
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-foreground/90">{t("dlg.tlsSni")}</Label>
                    <Input
                      value={form.sni}
                      onChange={(e) => setForm({ ...form, sni: e.target.value })}
                      placeholder={form.identifier || t("dlg.tlsSniPh")}
                    />
                    <p className="text-xs text-muted-foreground mt-1">{t("dlg.tlsSniHint")}</p>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium text-foreground/90">{t("dlg.tlsPin")}</Label>
                  <Input
                    value={form.pin}
                    onChange={(e) => setForm({ ...form, pin: e.target.value })}
                    placeholder={t("dlg.tlsPinPh")}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{t("dlg.tlsPinHint")}</p>
                </div>
              </div>
            )}

            {canOfferCompanion && (
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <label className="flex items-start gap-2.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alsoTrack}
                    onChange={(e) => setAlsoTrack(e.target.checked)}
                    className="h-4 w-4 mt-0.5 accent-emerald-500"
                  />
                  <span>
                    {form.type === 'https_cert' ? t("dlg.alsoDomain") : t("dlg.alsoCert")}
                    <span className="block text-xs text-muted-foreground mt-1">
                      {form.type === 'https_cert' ? t("dlg.alsoHintHost") : t("dlg.alsoHintDomain")}
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div>
              <Label className="text-sm font-medium text-foreground/90">{t("dlg.owner")}</Label>
              <Input 
                value={form.owner} 
                onChange={(e) => setForm({ ...form, owner: e.target.value })} 
                placeholder={t("dlg.ownerPh")} 
              />
            </div>

            <div>
              <Label className="text-sm font-medium text-foreground/90">Link do odnowienia (opcjonalnie)</Label>
              <Input 
                value={form.renewalUrl} 
                onChange={(e) => setForm({ ...form, renewalUrl: e.target.value })} 
                placeholder={t("dlg.renewalUrlPh")} 
              />
            </div>

            <div>
              <Label className="text-sm font-medium text-foreground/90">{t("dlg.expiryDate")}</Label>
              <Input 
                type="date" 
                value={form.expiryDate} 
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} 
              />
              <p className="text-xs text-muted-foreground mt-1">{t("dlg.expiryHint")}</p>
            </div>

            <div>
              <Label className="text-sm font-medium text-foreground/90">Notatki / instrukcja odnowienia</Label>
              <Textarea 
                value={form.notes} 
                onChange={(e) => setForm({ ...form, notes: e.target.value })} 
                rows={3} 
                placeholder={t("dlg.notesPh")} 
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowAddDialog(false)}>
                Anuluj
              </Button>
              <Button type="submit" disabled={savingItem} className="bg-emerald-500 hover:bg-emerald-600 text-black">
                {savingItem ? t("common.saving") : editingItem ? t("dlg.saveChanges") : t("dash.addItem")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirm !== null} onOpenChange={(open) => { if (!open) cancelDelete(); }}>
        <DialogContent className="sm:max-w-[420px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">{t("dlg.deleteTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
                {t("dlg.deleteDesc")}
                {deleteItem && (
                  <>
                    <br />
                    <span className="text-foreground font-medium">{deleteItem.name}</span>{" "}
                    <span className="font-mono text-xs">({deleteItem.identifier})</span>
                  </>
                )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancelDelete}>
              Anuluj
            </Button>
            <Button type="button" onClick={confirmDelete} className="bg-red-500 hover:bg-red-600 text-white">
              Usuń
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
