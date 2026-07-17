import { createHmac } from "node:crypto";
import { getSetting, getSecret } from "./settings";

/**
 * Outbound webhook: when items cross their expiry thresholds, POST a JSON
 * payload to an external URL (Discord/Slack relay, n8n, a home automation, …).
 * The body is signed with HMAC-SHA256 so the receiver can verify authenticity.
 */

export interface WebhookItem {
  name: string;
  type: string;
  identifier: string;
  daysLeft: number | null;
  status: string;
}

export interface WebhookResult {
  sent: boolean;
  status?: number;
  error?: string;
  skipped?: string;
}

export async function isWebhookEnabled(): Promise<boolean> {
  const enabled = (await getSetting("webhook_enabled", "false")) === "true";
  const url = await getSetting("webhook_url", "");
  return enabled && !!url;
}

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export async function sendWebhook(items: WebhookItem[]): Promise<WebhookResult> {
  const url = (await getSetting("webhook_url", ""))?.trim();
  if (!url) return { sent: false, skipped: "no-url" };

  const secret = (await getSecret("webhook_secret")) || "";
  const payload = {
    event: "items.expiring",
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AdminReminder/1.0",
  };
  if (secret) headers["X-AR-Signature"] = signPayload(secret, body);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    clearTimeout(timeout);
    return { sent: res.ok, status: res.status, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err: any) {
    return { sent: false, error: err.name === "AbortError" ? "timeout" : err.message || String(err) };
  }
}
