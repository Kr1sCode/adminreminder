import { db } from "./db";
import { services, ITEM_TYPE_LABELS, type Service } from "@/db/schema";
import { getThresholds } from "./settings";
import { computeStatus } from "./cert-checker";
import { getEmailConfig, sendEmail, renderNotificationEmail, emailTitle } from "./email";
import { isWebhookEnabled, sendWebhook, type WebhookItem } from "./webhook";
import { decideSide, parseDays, type SideKey } from "./notify-policy";
import { eq } from "drizzle-orm";

/** One expiry of one item: a website contributes a certificate and a domain. */
interface DueEntry {
  itemId: number;
  side: SideKey;
  name: string;
  /** Feeds describeExpiry(), so the wording matches what is expiring. */
  type: string;
  typeLabel: string;
  identifier: string;
  daysLeft: number;
  status: string;
  reason: "threshold" | "critical";
  recipients: string[];
}

/** A certificate row may also watch the registration of the domain behind it. */
function sidesOf(item: Service, expiringSoonDays: number) {
  const sides: { side: SideKey; type: string; typeLabel: string; identifier: string; expiry: Date | null }[] = [];

  if (item.type === "domain") {
    sides.push({ side: "domain", type: "domain", typeLabel: "Rejestracja domeny", identifier: item.identifier, expiry: item.expiryDate });
  } else {
    const label = ITEM_TYPE_LABELS[item.type as keyof typeof ITEM_TYPE_LABELS] || item.type;
    sides.push({ side: "cert", type: item.type, typeLabel: label, identifier: item.identifier, expiry: item.expiryDate });
    if (item.domainName) {
      sides.push({ side: "domain", type: "domain", typeLabel: "Rejestracja domeny", identifier: item.domainName, expiry: item.domainExpiryDate });
    }
  }

  return sides.map((s) => ({ ...s, ...computeStatus(s.expiry, expiringSoonDays) }));
}

export async function sendNotifications() {
  const emailConfig = await getEmailConfig();
  const emailReady = emailConfig.enabled && emailConfig.recipients.length > 0;
  const webhookReady = await isWebhookEnabled();

  if (!emailReady && !webhookReady) {
    return { success: false, error: "Żaden kanał powiadomień nie jest skonfigurowany", sent: 0 };
  }

  const { expiringSoonDays, urgentDays } = await getThresholds();
  const allItems = await db.select().from(services);

  const now = new Date();
  const due: DueEntry[] = [];
  /** id -> thresholds to persist, whether or not anything was sent. */
  const firedById = new Map<number, string[]>();

  for (const item of allItems) {
    if (item.mutedUntil && new Date(item.mutedUntil) > now) continue;

    const thresholds = parseDays(item.notificationDays, emailConfig.days);
    const extraRecipients = (item.notifyRecipients || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

    // "critical" repeats until the operator acts, so it keeps the old 20-hour
    // dedup. Threshold alerts need no such guard: each fires exactly once.
    const lastNotified = item.lastNotifiedAt ? new Date(item.lastNotifiedAt) : null;
    const hoursSinceLast = lastNotified ? (now.getTime() - lastNotified.getTime()) / 3_600_000 : Infinity;

    let fired = item.notifiedThresholds ?? [];

    for (const side of sidesOf(item, expiringSoonDays)) {
      const decision = decideSide({
        side: side.side,
        daysLeft: side.daysLeft,
        status: side.status,
        thresholds,
        fired,
      });
      fired = decision.fired;

      if (!decision.notify || decision.reason === null) continue;
      if (decision.reason === "critical" && hoursSinceLast < 20) continue;

      due.push({
        itemId: item.id,
        side: side.side,
        name: item.name,
        type: side.type,
        typeLabel: side.typeLabel,
        identifier: side.identifier,
        daysLeft: side.daysLeft as number,
        status: side.status,
        reason: decision.reason,
        recipients: extraRecipients,
      });
    }

    if (JSON.stringify(fired) !== JSON.stringify(item.notifiedThresholds ?? [])) {
      firedById.set(item.id, fired);
    }
  }

  // A reset after renewal must be persisted even when nothing is sent, or the
  // next approach to a threshold would look like it had already alerted. New
  // marks, in contrast, may only be written once a channel accepted the batch —
  // otherwise a failed send would silently consume the alert.
  const notifiedIds = new Set(due.map((d) => d.itemId));
  for (const [id, fired] of firedById) {
    if (notifiedIds.has(id)) continue;
    await db.update(services).set({ notifiedThresholds: fired, updatedAt: now }).where(eq(services.id, id));
  }

  if (due.length === 0) {
    return { success: true, sent: 0, message: "Brak pozycji wymagających powiadomienia" };
  }

  let emailOk = false;
  let emailError: string | null = null;
  if (emailReady) {
    const subject = `AR — ${emailTitle("batch", emailConfig.locale)}`;
    const render = renderNotificationEmail(due, {
      locale: emailConfig.locale,
      urgentDays,
      appOrigin: process.env.APP_ORIGIN ?? null,
    });
    const res = await sendEmail(emailConfig.recipients, subject, render.html, render.text);
    emailOk = res.success;
    emailError = res.error || null;

    // Per-item recipients get only their own item, so adding an address to one
    // service never exposes the rest of the inventory to it.
    for (const entry of due.filter((d) => d.recipients.length > 0)) {
      const single = renderNotificationEmail([entry], {
        locale: emailConfig.locale,
        title: emailTitle("single", emailConfig.locale),
        urgentDays,
        appOrigin: process.env.APP_ORIGIN ?? null,
      });
      await sendEmail(entry.recipients, `AR — ${entry.name}`, single.html, single.text);
    }
  }

  let webhookOk = false;
  let webhookError: string | null = null;
  if (webhookReady) {
    const payload: WebhookItem[] = due.map((d) => ({
      name: d.name,
      type: d.type,
      identifier: d.identifier,
      daysLeft: d.daysLeft,
      status: d.status,
    }));
    const res = await sendWebhook(payload);
    webhookOk = res.sent;
    webhookError = res.error || null;
  }

  // Only stamp lastNotifiedAt once a channel accepted the batch, so a total
  // delivery failure retries next run instead of going silent.
  if (emailOk || webhookOk) {
    for (const id of notifiedIds) {
      await db
        .update(services)
        .set({
          lastNotifiedAt: now,
          ...(firedById.has(id) ? { notifiedThresholds: firedById.get(id)! } : {}),
          updatedAt: now,
        })
        .where(eq(services.id, id));
    }
  }

  return {
    success: emailOk || webhookOk,
    sent: due.length,
    recipients: emailReady ? emailConfig.recipients.length : 0,
    email: emailReady ? { ok: emailOk, error: emailError } : null,
    webhook: webhookReady ? { ok: webhookOk, error: webhookError } : null,
  };
}
