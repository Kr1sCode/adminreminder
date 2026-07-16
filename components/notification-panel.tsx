"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { X, BellOff, Save } from "lucide-react";
import { format } from "date-fns";
import { useT } from "@/components/i18n-provider";

/** One-click presets only. A per-item threshold is NOT limited to these — the
 *  custom field lets the operator enter any number of days, and the API
 *  (notifications/route.ts) validates a range rather than a fixed list. */
const PRESET_DAYS = [3, 7, 21, 30, 45];
const MAX_DAY = 3650;

export interface NotificationTarget {
  /** An inventory item's row id. AD targets save through `onSave` and omit it. */
  id?: number;
  name: string;
  identifier: string;
  notificationDays?: string | null;
  mutedUntil?: string | Date | null;
  notifyRecipients?: string | null;
  notifiedThresholds?: string[] | null;
  lastNotifiedAt?: string | Date | null;
}

/**
 * An expiry the target can be alerted about. The inventory has one (the item's
 * own date) and does not declare it; the directory has two — the password and
 * the account itself — which expire on unrelated clocks and are set apart.
 */
export interface PanelSide {
  key: string;
  /** Section heading. Omitted for the single unnamed side of an inventory item. */
  label?: string;
  hint?: string;
  /** Global fallback for this side, shown as "use the global thresholds". */
  globalDays: number[];
  /** The target's own thresholds; null inherits the global ones. */
  days: string | null;
  /** Present when the side can be switched off entirely. */
  enabled?: boolean;
}

export interface SideValues {
  key: string;
  enabled: boolean;
  /** Null means "inherit the global thresholds". */
  days: number[] | null;
}

export interface NotificationValues {
  /** The first side's thresholds — what the inventory's endpoint expects. */
  days: number[] | null;
  sides: SideValues[];
  mutedUntil: string | null;
  recipients: string | null;
}

interface Props {
  item: NotificationTarget | null;
  /** Global fallback for the default (unnamed) side. */
  globalDays: number[];
  /** Overrides the default side with named ones, each with its own thresholds. */
  sides?: PanelSide[];
  onClose: () => void;
  onSaved: () => void;
  /**
   * Replaces the default save against the inventory's endpoint. Returns an error
   * message to show in the panel, or null when the save went through. The
   * directory needs this: its policy hangs on an OU or an account, not on a row.
   */
  onSave?: (values: NotificationValues) => Promise<string | null>;
  /** Rendered above the thresholds — where the directory puts its opt-in. */
  children?: ReactNode;
  /** An OU has no history of its own: what fired is recorded per account. */
  showHistory?: boolean;
}

const toDateInput = (value: string | Date | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

const parseDays = (csv: string | null | undefined): number[] =>
  (csv || "")
    .split(",")
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d));

/** One side's editor: inherit-or-choose, plus a free-form day. */
interface SideState {
  enabled: boolean;
  inherit: boolean;
  days: number[];
  custom: string;
}

/**
 * Slide-over with the notification policy for one target. Opens from the bell in
 * the row's action column.
 */
export function NotificationPanel({
  item,
  globalDays,
  sides,
  onClose,
  onSaved,
  onSave,
  children,
  showHistory = true,
}: Props) {
  const t = useT();

  const [state, setState] = useState<Record<string, SideState>>({});
  const [mutedUntil, setMutedUntil] = useState("");
  const [recipients, setRecipients] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slide animation. `render` keeps the panel mounted through the closing
  // transition; `open` drives the transform; `shown` retains the item so the
  // content stays visible while it slides out after `item` has gone null.
  const [render, setRender] = useState(false);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<NotificationTarget | null>(null);

  // An inventory item has a single, unnamed expiry; only the directory names its
  // sides, so the default keeps the old single-threshold panel exactly as it was.
  const panelSides: PanelSide[] = sides ?? [
    { key: "default", globalDays, days: item?.notificationDays ?? null },
  ];

  // Reload whenever a different row is opened; the panel is reused, not remounted.
  useEffect(() => {
    if (!item) return;

    const next: Record<string, SideState> = {};
    for (const side of panelSides) {
      const own = parseDays(side.days);
      next[side.key] = {
        enabled: side.enabled ?? true,
        inherit: own.length === 0,
        days: own.length > 0 ? own : side.globalDays,
        custom: "",
      };
    }

    setState(next);
    setMutedUntil(toDateInput(item.mutedUntil));
    setRecipients(item.notifyRecipients || "");
    setError(null);
    // The sides are rebuilt from `item` on every open; depending on the array
    // itself would reset the editor on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, globalDays]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (item) {
      setShown(item);
      setRender(true);
      // Next frame, so the browser paints the off-screen state first and then
      // transitions into place; flipping both in one frame skips the animation.
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
    setOpen(false);
    const id = setTimeout(() => setRender(false), 300);
    return () => clearTimeout(id);
  }, [item]);

  if (!render || !shown) return null;

  const isMuted = !!shown.mutedUntil && new Date(shown.mutedUntil) > new Date();
  const fired = shown.notifiedThresholds ?? [];

  function patch(key: string, change: Partial<SideState>) {
    setState((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  }

  function toggleDay(key: string, day: number) {
    const side = state[key];
    if (!side) return;
    patch(key, {
      days: side.days.includes(day)
        ? side.days.filter((d) => d !== day)
        : [...side.days, day].sort((a, b) => a - b),
    });
  }

  function addCustomDay(key: string) {
    const side = state[key];
    if (!side) return;
    const n = parseInt(side.custom, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAY) return;
    patch(key, {
      days: side.days.includes(n) ? side.days : [...side.days, n].sort((a, b) => a - b),
      custom: "",
    });
  }

  async function save() {
    if (!item) return;
    setSaving(true);
    setError(null);

    const sideValues: SideValues[] = panelSides.map((side) => {
      const current = state[side.key];
      return {
        key: side.key,
        enabled: current?.enabled ?? true,
        days: current?.inherit ? null : current?.days ?? null,
      };
    });

    const values: NotificationValues = {
      days: sideValues[0]?.days ?? null,
      sides: sideValues,
      mutedUntil: mutedUntil || null,
      recipients: recipients.trim() || null,
    };

    try {
      if (onSave) {
        const message = await onSave(values);
        if (message) {
          setError(message);
          return;
        }
      } else {
        const res = await fetch(`/api/services/${item.id}/notifications`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            days: values.days,
            mutedUntil: values.mutedUntil,
            recipients: values.recipients,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || t("notif.saveError", { status: res.status }));
          return;
        }
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-label={`${t("notif.title")}: ${shown.name}`}
        className={`relative h-full w-full max-w-md bg-card border-l border-border shadow-xl overflow-y-auto transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <header className="flex items-start justify-between gap-3 px-6 py-5 border-b border-border">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{t("notif.title")}</div>
            <div className="font-medium truncate" title={shown.name}>{shown.name}</div>
            <div className="text-xs text-muted-foreground font-mono truncate">{shown.identifier}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 px-2" aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="px-6 py-5 space-y-6">
          {children}

          {isMuted && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500 dark:text-amber-400">
              <BellOff className="h-4 w-4 flex-shrink-0" />
              {t("notif.mutedUntil", { date: format(new Date(shown.mutedUntil!), "dd.MM.yyyy") })}
            </div>
          )}

          {panelSides.map((side) => {
            const current = state[side.key];
            if (!current) return null;

            // Presets plus whatever the global policy uses plus anything already
            // set here, so a global value like 14 is a real, toggleable chip
            // rather than an invisible selection the operator cannot remove.
            const dayOptions = Array.from(
              new Set([...PRESET_DAYS, ...side.globalDays, ...current.days])
            ).sort((a, b) => a - b);

            const off = side.enabled !== undefined && !current.enabled;

            return (
              <section key={side.key}>
                <Label className="text-sm font-medium">{side.label ?? t("notif.whenTitle")}</Label>
                <p className="text-xs text-muted-foreground mt-1">{side.hint ?? t("notif.whenHint")}</p>

                {side.enabled !== undefined && (
                  <label className="flex items-center gap-2.5 text-sm cursor-pointer mt-3">
                    <input
                      type="checkbox"
                      checked={current.enabled}
                      onChange={(e) => patch(side.key, { enabled: e.target.checked })}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    {t("notif.sideEnabled")}
                  </label>
                )}

                <div className={off ? "opacity-40 pointer-events-none" : ""}>
                  <label className="flex items-center gap-2.5 text-sm cursor-pointer mt-3">
                    <input
                      type="checkbox"
                      checked={current.inherit}
                      onChange={(e) => {
                        patch(side.key, {
                          inherit: e.target.checked,
                          ...(e.target.checked ? { days: side.globalDays } : {}),
                        });
                      }}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    {t("notif.useGlobal", { days: side.globalDays.join(", ") })}
                  </label>

                  <div className={`flex flex-wrap gap-2 mt-3 ${current.inherit ? "opacity-40 pointer-events-none" : ""}`}>
                    {dayOptions.map((day) => {
                      const active = current.days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleDay(side.key, day)}
                          aria-pressed={active}
                          className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                            active
                              ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                              : "border-border text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {t("notif.days", { n: day })}
                        </button>
                      );
                    })}
                  </div>

                  <div className={`flex items-center gap-2 mt-3 ${current.inherit ? "opacity-40 pointer-events-none" : ""}`}>
                    <Input
                      type="number"
                      min={1}
                      max={MAX_DAY}
                      value={current.custom}
                      onChange={(e) => patch(side.key, { custom: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomDay(side.key);
                        }
                      }}
                      placeholder={t("notif.customPlaceholder")}
                      className="w-32 h-8 text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addCustomDay(side.key)}
                      className="border-border"
                    >
                      {t("notif.customAdd")}
                    </Button>
                  </div>

                  {!current.inherit && current.days.length === 0 && (
                    <p className="text-xs text-amber-500 dark:text-amber-400 mt-2">
                      {t("notif.noThreshold")}
                    </p>
                  )}
                </div>
              </section>
            );
          })}

          <section>
            <Label className="text-sm font-medium">{t("notif.muteTitle")}</Label>
            <p className="text-xs text-muted-foreground mt-1">
              {t("notif.muteHint")}
            </p>
            <div className="flex gap-2 mt-2">
              <Input type="date" value={mutedUntil} onChange={(e) => setMutedUntil(e.target.value)} />
              {mutedUntil && (
                <Button variant="outline" onClick={() => setMutedUntil("")} className="border-border">
                  {t("common.clear")}
                </Button>
              )}
            </div>
          </section>

          <section>
            <Label className="text-sm font-medium">{t("notif.recipientsTitle")}</Label>
            <p className="text-xs text-muted-foreground mt-1">
              {t("notif.recipientsHint")}
            </p>
            <Input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="ops@firma.pl, sieci@firma.pl"
              className="mt-2 font-mono text-xs"
            />
          </section>

          <section className={showHistory ? "" : "hidden"}>
            <Label className="text-sm font-medium">{t("notif.historyTitle")}</Label>
            <div className="mt-2 text-xs text-muted-foreground space-y-1.5">
              <div>
                {t("notif.lastSent")}{" "}
                {shown.lastNotifiedAt
                  ? format(new Date(shown.lastNotifiedAt), "dd.MM.yyyy, HH:mm")
                  : t("common.never")}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span>{t("notif.firedThresholds")}</span>
                {fired.length === 0 ? (
                  <span>{t("notif.none")}</span>
                ) : (
                  fired.map((f) => (
                    <Badge key={f} variant="outline" className="text-[10px] border-border font-mono">
                      {f}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </section>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <footer className="sticky bottom-0 flex justify-end gap-2 px-6 py-4 border-t border-border bg-card">
          <Button variant="outline" onClick={onClose} className="border-border">{t("common.cancel")}</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-500 hover:bg-emerald-600 text-black">
            <Save className="h-4 w-4 mr-2" />
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </footer>
      </aside>
    </div>
  );
}
