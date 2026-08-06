/**
 * In-app scheduler. The "Automatyzacja" tab is the source of truth: it stores a
 * standard 5-field cron expression in the settings table, and this module runs
 * the same job the external cron endpoint does — checks + notifications — when
 * that expression matches the current minute.
 *
 * Times are evaluated in the process's local timezone (TZ, e.g. Europe/Warsaw),
 * so "08:00 daily" means 08:00 for the operator, not UTC. V8 resolves the zone
 * from its bundled ICU data even when the base image ships no /usr/share/zoneinfo.
 */
import { getSetting, setSetting } from "./settings";
import { runChecks } from "./check";
import { sendNotifications } from "./notify";
import { sendAdAccountNotifications } from "./ad/notify-accounts";
import { refreshAdHealthIfStale } from "./ad/health";
import { listDirectories } from "./directories";
import { runDirectorySync, syncAllDirectoriesNow } from "./directory-sync";

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

export const DEFAULT_CRON = "0 */6 * * *";

/** Expands one comma/range/step field (a step, a range like 1-5, or a list) to a set. */
function parseField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const partRaw of expr.split(",")) {
    const part = partRaw.trim();
    if (part === "") throw new Error("pusty człon");
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = parseInt(part.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step < 1) throw new Error(`zły krok: "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`zła wartość: "${part}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`poza zakresem [${min}-${max}]: "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error("pusty zbiór");
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("wyrażenie cron musi mieć 5 pól (minuta godzina dzień miesiąc dzień-tygodnia)");
  }
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = new Set<number>();
  for (const d of parseField(parts[4], 0, 7)) dow.add(d === 7 ? 0 : d); // 0 and 7 are both Sunday
  return { minute, hour, dom, month, dow };
}

export function validateCron(expr: string): { ok: boolean; error?: string } {
  try {
    parseCron(expr);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "nieprawidłowe wyrażenie" };
  }
}

/**
 * Standard cron day semantics: when both day-of-month and day-of-week are
 * restricted, a match on either fires; otherwise only the restricted one gates.
 */
function matches(f: CronFields, d: Date): boolean {
  const domRestricted = f.dom.size !== 31;
  const dowRestricted = f.dow.size !== 7;
  const dayOk =
    domRestricted && dowRestricted
      ? f.dom.has(d.getDate()) || f.dow.has(d.getDay())
      : (!domRestricted || f.dom.has(d.getDate())) && (!dowRestricted || f.dow.has(d.getDay()));
  return f.minute.has(d.getMinutes()) && f.hour.has(d.getHours()) && f.month.has(d.getMonth() + 1) && dayOk;
}

/** The next `count` fire times at or after `from`, for the UI preview. */
export function nextRuns(expr: string, from: Date, count: number, capDays = 400): Date[] {
  const fields = parseCron(expr);
  const res: Date[] = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  const limit = from.getTime() + capDays * 86_400_000;
  while (res.length < count && d.getTime() <= limit) {
    if (matches(fields, d)) res.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return res;
}

// ── Job execution ───────────────────────────────────────────────────────────
let jobRunning = false;

async function recordRun(when: Date, status: "ok" | "error", detail: string) {
  await setSetting("automation_last_run_at", String(Math.floor(when.getTime() / 1000)));
  await setSetting("automation_last_status", status);
  await setSetting("automation_last_detail", detail);
}

/** Runs checks + notifications and stamps the result. Never runs twice at once. */
export async function runScheduledJob(source: "cron" | "manual"): Promise<{ ok: boolean; detail: string }> {
  if (jobRunning) return { ok: false, detail: "zadanie już trwa" };
  jobRunning = true;
  const started = new Date();
  try {
    if (source === "manual") {
      // A human clicking "uruchom teraz" means right now, for everything —
      // unlike the autonomous cron tick, which leaves each directory to its
      // own independent cadence (see tickDirectories below).
      await syncAllDirectoriesNow();
    }
    const checks = await runChecks();
    const notify = await sendNotifications();
    // Directory alerts ride the same run: the accounts are refreshed by their own
    // sync, so there is nothing to check here — only thresholds to evaluate.
    const accounts = await sendAdAccountNotifications();
    const sent =
      (typeof notify?.sent === "number" ? notify.sent : 0) +
      (typeof accounts?.sent === "number" ? accounts.sent : 0);
    const detail = `sprawdzono ${checks?.checked ?? 0}, wysłano ${sent}`;
    await recordRun(started, "ok", detail);
    console.log(`[AR] Scheduler (${source}): ${detail}`);
    return { ok: true, detail };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "błąd";
    await recordRun(started, "error", detail);
    console.error(`[AR] Scheduler (${source}) błąd:`, e);
    return { ok: false, detail };
  } finally {
    jobRunning = false;
  }
}

// ── Per-directory sync cadence ──────────────────────────────────────────────
// Independent of the core loop below: a directory with no syncCron of its own
// inherits automation_cron (so the common case — no overrides — behaves
// exactly like before, just synced here instead of inside runChecks()), but
// one with an override fires on its OWN schedule, decoupled from everyone
// else's. Same catch-up-window approach as the core loop, tracked per
// directory id rather than as a single process-wide lastTick.
const directoryLastTick = new Map<number, number>();

async function tickDirectories(now: number) {
  const enabled = (await getSetting("automation_enabled", "false")) === "true";
  if (!enabled) return;

  const globalCron = (await getSetting("automation_cron", DEFAULT_CRON)) || DEFAULT_CRON;
  const dirs = await listDirectories();

  for (const dir of dirs) {
    if (!dir.enabled) {
      directoryLastTick.delete(dir.id);
      continue;
    }

    let fields: CronFields;
    try {
      fields = parseCron(dir.syncCron || globalCron);
    } catch {
      continue; // bad per-directory expression: never fire, same policy as the core loop
    }

    const last = directoryLastTick.get(dir.id) ?? now;
    const from = Math.max(last, now - CATCHUP_MS);
    const cur = new Date(from);
    cur.setSeconds(0, 0);
    cur.setMinutes(cur.getMinutes() + 1);
    let fire = false;
    while (cur.getTime() <= now) {
      if (matches(fields, cur)) {
        fire = true;
        break;
      }
      cur.setMinutes(cur.getMinutes() + 1);
    }
    directoryLastTick.set(dir.id, now);
    if (fire) await runDirectorySync(dir);
  }
}

// ── The loop ────────────────────────────────────────────────────────────────
let started = false;
let lastTick = 0;
const TICK_MS = 30_000;
const CATCHUP_MS = 90 * 60_000; // after a pause/downtime, look back at most 90 min

async function tick() {
  // Both run every tick regardless of the core "automation_enabled" check
  // below: the AD watchdog light is core reliability monitoring, and the
  // per-directory loop has its own (same) enabled gate internally — neither
  // should wait on the core loop's early return for a bad/missing cron.
  refreshAdHealthIfStale().catch((e) => console.error("[AR] AD health tick error:", e));
  tickDirectories(Date.now()).catch((e) => console.error("[AR] Directory sync tick error:", e));

  try {
    const enabled = (await getSetting("automation_enabled", "false")) === "true";
    const now = Date.now();
    if (!enabled) {
      lastTick = now;
      return;
    }
    const cron = (await getSetting("automation_cron", DEFAULT_CRON)) || DEFAULT_CRON;
    let fields: CronFields;
    try {
      fields = parseCron(cron);
    } catch {
      lastTick = now; // bad expression: never fire, wait for the operator to fix it
      return;
    }

    // Test every whole minute in (lastTick, now]; catches a minute the tick drifted
    // past, while the cap keeps a long sleep from firing a flood of back-runs.
    const from = Math.max(lastTick, now - CATCHUP_MS);
    const cur = new Date(from);
    cur.setSeconds(0, 0);
    cur.setMinutes(cur.getMinutes() + 1);
    let fire = false;
    while (cur.getTime() <= now) {
      if (matches(fields, cur)) {
        fire = true;
        break;
      }
      cur.setMinutes(cur.getMinutes() + 1);
    }
    lastTick = now;
    if (fire && !jobRunning) await runScheduledJob("cron");
  } catch (e) {
    console.error("[AR] Scheduler tick error:", e);
  }
}

/** Starts the loop once per process. Called from instrumentation on boot. */
export function startScheduler() {
  if (started) return;
  if (process.env.AR_SCHEDULER === "off") {
    console.log("[AR] Scheduler wyłączony (AR_SCHEDULER=off).");
    return;
  }
  started = true;
  lastTick = Date.now();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`[AR] Scheduler aktywny (strefa czasowa: ${tz}, tick ${TICK_MS / 1000}s).`);
  const handle = setInterval(tick, TICK_MS);
  handle.unref?.(); // don't keep the process alive just for the timer
}

export interface AutomationState {
  enabled: boolean;
  cron: string;
  valid: boolean;
  error: string | null;
  timezone: string;
  nextRuns: number[];
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDetail: string | null;
}

export async function getAutomationState(): Promise<AutomationState> {
  const enabled = (await getSetting("automation_enabled", "false")) === "true";
  const cron = (await getSetting("automation_cron", DEFAULT_CRON)) || DEFAULT_CRON;
  const lastAt = await getSetting("automation_last_run_at");
  const v = validateCron(cron);
  return {
    enabled,
    cron,
    valid: v.ok,
    error: v.error ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRuns: v.ok ? nextRuns(cron, new Date(), 3).map((d) => d.getTime()) : [],
    lastRunAt: lastAt ? parseInt(lastAt, 10) * 1000 : null,
    lastStatus: (await getSetting("automation_last_status")) ?? null,
    lastDetail: (await getSetting("automation_last_detail")) ?? null,
  };
}
