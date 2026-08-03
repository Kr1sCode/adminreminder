import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAllSettings, setSetting, SECRET_KEYS, isMasked } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }
  const all = await getAllSettings();
  return NextResponse.json(all);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  try {
    const body = await request.json();

    // Allow updating known settings. Secret keys are encrypted by setSetting();
    // a value equal to the mask means "unchanged" and is ignored there.
    const allowed = [
      // Progi
      "expiring_soon_days",
      "urgent_days",
      // Powiadomienia
      "notifications_enabled",
      "notification_recipients",
      "notification_days",
      "notification_locale",
      "email_provider",
      "email_from",
      "resend_api_key",
      "smtp_host",
      "smtp_port",
      "smtp_user",
      "smtp_pass",
      // Azure / Entra ID
      "azure_tenant_id",
      "azure_client_id",
      "azure_client_secret",
      // Active Directory — połączenie
      "ad_url",
      "ad_start_tls",
      "ad_allow_insecure",
      "ad_tls_reject_unauthorized",
      "ad_ca_cert_path",
      "ad_bind_dn",
      "ad_bind_password",
      "ad_base_dn",
      "ad_timeout_ms",
      // Active Directory — role i klasyfikacja
      "ad_admin_group_dn",
      "ad_viewer_group_dn",
      "ad_technical_ous",
      "ad_technical_patterns",
      "ad_functional_ous",
      "ad_functional_patterns",
      // Active Directory — progi powiadomień; hasło i konto wygasają osobno
      "ad_password_days",
      "ad_account_days",
      // Webhook wychodzący
      "webhook_enabled",
      "webhook_url",
      "webhook_secret",
    ];

    const changed: string[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (allowed.includes(key) && typeof value === "string") {
        await setSetting(key, value);
        changed.push(key);
      }
    }

    // Key names only. A settings row may hold an SMTP password or a client
    // secret, and an audit log that leaks them is worse than no log at all.
    // Echoing the mask back means "leave alone", so those keys are not reported.
    const reported = changed.filter((k) => !(SECRET_KEYS.has(k) && isMasked(body[k] as string)));

    if (reported.length > 0) {
      await recordAudit({
        actor: user,
        action: "settings.update",
        entityType: "settings",
        details: {
          zmienione_klucze: reported,
          w_tym_sekrety: reported.filter((k) => SECRET_KEYS.has(k)),
        },
      });
    }

    const updated = await getAllSettings();
    return NextResponse.json({ success: true, settings: updated });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Błąd zapisu ustawień" }, { status: 500 });
  }
}
