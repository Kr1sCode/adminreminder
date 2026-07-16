import { db } from "@/lib/db";
import { adAccounts, adNotifyPolicies } from "@/db/schema";
import { getThresholds, getAdThresholds } from "@/lib/settings";
import { computeStatus } from "@/lib/cert-checker";
import { getEmailConfig, sendEmail, renderNotificationEmail, type EmailLocale } from "@/lib/email";
import { isWebhookEnabled, sendWebhook, type WebhookItem } from "@/lib/webhook";
import { decideSide, type SideKey } from "@/lib/notify-policy";
import { indexPolicies, resolvePolicy, type AdSide } from "./notify-scope";
import { eq } from "drizzle-orm";

/**
 * Alerts about accounts whose password — or the account itself — is running out.
 *
 * The rules of lib/notify.ts hold here too: a threshold fires once, "expired"
 * keeps nagging under a 20-hour dedup, and a reset after a password change is
 * persisted even when nothing is sent. What differs is who is watched at all:
 * the inventory alerts on everything by default, the directory only on what an
 * operator ticked (see lib/ad/notify-scope.ts).
 *
 * The two expiries are independent. A password runs out on a rolling policy and
 * the user fixes it themselves; an account runs out once, on the day someone's
 * contract ends. Each side carries its own switch and its own thresholds, and
 * each records separately that it has already fired ("password:7", "account:30").
 */

const M = {
  pl: {
    title: "Wygasające konta i hasła w katalogu",
    titlePassword: "Wygasające hasła kont katalogowych",
    titleAccount: "Wygasające konta katalogowe",
    single: "Wygasające konto katalogowe",
    password: "Hasło konta",
    account: "Ważność konta",
  },
  en: {
    title: "Directory accounts and passwords approaching expiry",
    titlePassword: "Directory passwords approaching expiry",
    titleAccount: "Directory accounts approaching expiry",
    single: "A directory account is approaching expiry",
    password: "Account password",
    account: "Account validity",
  },
} as const;

/** Names the batch after what is actually in it, rather than always saying "passwords". */
function batchTitle(sides: Set<AdSide>, m: (typeof M)[EmailLocale]): string {
  if (sides.size === 1) return sides.has("password") ? m.titlePassword : m.titleAccount;
  return m.title;
}

interface DueEntry {
  accountId: number;
  side: AdSide;
  name: string;
  type: string;
  typeLabel: string;
  identifier: string;
  daysLeft: number;
  status: string;
  reason: "threshold" | "critical";
  recipients: string[];
}

export async function sendAdAccountNotifications() {
  const emailConfig = await getEmailConfig();
  const emailReady = emailConfig.enabled && emailConfig.recipients.length > 0;
  const webhookReady = await isWebhookEnabled();

  if (!emailReady && !webhookReady) {
    return { success: false, error: "Żaden kanał powiadomień nie jest skonfigurowany", sent: 0 };
  }

  const { expiringSoonDays, urgentDays } = await getThresholds();
  const globalDays = await getAdThresholds();
  const locale: EmailLocale = emailConfig.locale;
  const m = M[locale];

  const policies = await db.select().from(adNotifyPolicies);
  if (policies.length === 0) {
    return { success: true, sent: 0, message: "Żadne OU ani konto nie ma włączonych powiadomień" };
  }

  const index = indexPolicies(policies);
  const accounts = await db.select().from(adAccounts);

  const now = new Date();
  const due: DueEntry[] = [];
  /** id -> thresholds to persist, whether or not anything was sent. */
  const firedById = new Map<number, string[]>();

  for (const account of accounts) {
    // A disabled account cannot log in, so nothing about its password is urgent.
    if (!account.enabled) continue;

    const policy = resolvePolicy(account, index, globalDays);
    if (!policy || !policy.enabled) continue;
    if (policy.mutedUntil && policy.mutedUntil > now) continue;

    const lastNotified = account.lastNotifiedAt ? new Date(account.lastNotifiedAt) : null;
    const hoursSinceLast = lastNotified ? (now.getTime() - lastNotified.getTime()) / 3_600_000 : Infinity;

    const label = account.displayName || account.samAccountName;
    const identifier = account.userPrincipalName || account.samAccountName;

    const sides: { side: AdSide; expiry: Date | null; typeLabel: string; thresholds: number[]; on: boolean }[] = [
      // Null expiry when the directory says the password never expires, or when
      // the account has no end date; decideSide then stays quiet on its own.
      { side: "password", expiry: account.passwordExpiresAt, typeLabel: m.password, thresholds: policy.password.thresholds, on: policy.password.enabled },
      { side: "account", expiry: account.accountExpiresAt, typeLabel: m.account, thresholds: policy.account.thresholds, on: policy.account.enabled },
    ];

    let fired = account.notifiedThresholds ?? [];

    for (const side of sides) {
      if (!side.on) continue;

      const { status, daysLeft } = computeStatus(side.expiry, expiringSoonDays);
      const decision = decideSide({
        side: side.side as SideKey,
        daysLeft,
        status,
        thresholds: side.thresholds,
        fired,
      });
      fired = decision.fired;

      if (!decision.notify || decision.reason === null) continue;
      if (decision.reason === "critical" && hoursSinceLast < 20) continue;

      due.push({
        accountId: account.id,
        side: side.side,
        name: label,
        type: `ad_${side.side}`,
        typeLabel: side.typeLabel,
        identifier,
        daysLeft: daysLeft as number,
        status,
        reason: decision.reason,
        recipients: policy.recipients,
      });
    }

    if (JSON.stringify(fired) !== JSON.stringify(account.notifiedThresholds ?? [])) {
      firedById.set(account.id, fired);
    }
  }

  // A reset after a password change must be persisted even when nothing is sent,
  // or the next approach to a threshold would look like it had already alerted.
  const notifiedIds = new Set(due.map((d) => d.accountId));
  for (const [id, fired] of firedById) {
    if (notifiedIds.has(id)) continue;
    await db.update(adAccounts).set({ notifiedThresholds: fired }).where(eq(adAccounts.id, id));
  }

  if (due.length === 0) {
    return { success: true, sent: 0, message: "Brak kont wymagających powiadomienia" };
  }

  const title = batchTitle(new Set(due.map((d) => d.side)), m);

  let emailOk = false;
  let emailError: string | null = null;
  if (emailReady) {
    const render = renderNotificationEmail(due, {
      locale,
      title,
      urgentDays,
      appOrigin: process.env.APP_ORIGIN ?? null,
    });
    const res = await sendEmail(emailConfig.recipients, `AR — ${title}`, render.html, render.text);
    emailOk = res.success;
    emailError = res.error || null;

    // Recipients named on one policy get only the accounts that policy covers,
    // so adding an address to one OU never exposes the rest of the directory.
    const byRecipient = new Map<string, DueEntry[]>();
    for (const entry of due.filter((d) => d.recipients.length > 0)) {
      const key = entry.recipients.join(",");
      byRecipient.set(key, [...(byRecipient.get(key) ?? []), entry]);
    }

    for (const [key, entries] of byRecipient) {
      const ownTitle = entries.length === 1 ? m.single : batchTitle(new Set(entries.map((e) => e.side)), m);
      const single = renderNotificationEmail(entries, {
        locale,
        title: ownTitle,
        urgentDays,
        appOrigin: process.env.APP_ORIGIN ?? null,
      });
      await sendEmail(key.split(","), `AR — ${ownTitle}`, single.html, single.text);
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
  // delivery failure retries next run instead of consuming the alert in silence.
  if (emailOk || webhookOk) {
    for (const id of notifiedIds) {
      await db
        .update(adAccounts)
        .set({
          lastNotifiedAt: now,
          ...(firedById.has(id) ? { notifiedThresholds: firedById.get(id)! } : {}),
        })
        .where(eq(adAccounts.id, id));
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
