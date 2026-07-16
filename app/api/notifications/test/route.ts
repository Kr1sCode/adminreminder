import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getEmailConfig, sendEmail, renderNotificationEmail, emailTitle } from "@/lib/email";
import { getThresholds } from "@/lib/settings";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const config = await getEmailConfig();

  if (!config.enabled || config.recipients.length === 0) {
    return NextResponse.json({ success: false, error: "Brak włączonych powiadomień lub odbiorców" }, { status: 400 });
  }

  const testItems = [
    {
      name: "TEST — Certyfikat testowy",
      type: "https_cert",
      typeLabel: "Certyfikat HTTPS",
      identifier: "test.example.com",
      daysLeft: 12,
      owner: "Admin",
    },
    {
      name: "TEST — Sekret Azure",
      type: "azure_secret",
      typeLabel: "Sekret Azure (Graph API)",
      identifier: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      daysLeft: 5,
      owner: "DevOps",
    },
    // One of each urgency band, so the test mail shows every section and colour.
    {
      name: "TEST — Rejestracja domeny",
      type: "domain",
      typeLabel: "Rejestracja domeny",
      identifier: "przyklad.pl",
      daysLeft: -3,
      owner: "IT",
      renewalUrl: "https://example.com/odnow",
    },
  ];

  const subject = "AR — Testowe powiadomienie";
  const { urgentDays } = await getThresholds();
  const render = renderNotificationEmail(testItems, {
    locale: config.locale,
    title: `TEST — ${emailTitle("batch", config.locale)}`,
    urgentDays,
    appOrigin: process.env.APP_ORIGIN ?? null,
  });

  const result = await sendEmail(config.recipients, subject, render.html, render.text);

  return NextResponse.json({
    success: result.success,
    message: result.success ? "Testowe powiadomienie wysłane!" : result.error,
  });
}
