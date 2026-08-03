import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { syncAdAccounts } from "@/lib/ad/sync";
import { adSecurityWarnings, AdConfigError } from "@/lib/ad/config";
import { getAdConfig } from "@/lib/ad/resolve";
import { recordAdHealth } from "@/lib/ad/health";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const config = await getAdConfig();
    return NextResponse.json({
      configured: config !== null,
      encrypted: config?.encrypted ?? null,
      warnings: config ? adSecurityWarnings(config) : [],
    });
  } catch (e: any) {
    return NextResponse.json({ configured: true, error: e.message, warnings: [] });
  }
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  // "Not configured" is not a health event — only a genuine attempt to bind
  // (config present, credentials wrong or the DC unreachable) should move
  // the watchdog light in Ustawienia → Active Directory.
  const configured = await getAdConfig().catch(() => null);

  try {
    const result = await syncAdAccounts();
    if (configured) await recordAdHealth("ok", "Połączono z kontrolerem domeny.");
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    console.error("AD sync error:", e);
    const status = e instanceof AdConfigError ? 400 : 500;
    const message = e.message || "Błąd synchronizacji z AD";
    if (configured) await recordAdHealth("error", message);
    return NextResponse.json({ error: message }, { status });
  }
}
