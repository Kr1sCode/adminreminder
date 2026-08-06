import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { syncAllAdDirectories } from "@/lib/ad/sync";
import { adSecurityWarnings } from "@/lib/ad/config";
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

/** Syncs every enabled AD directory (used by the "Synchronizuj" button on the
 *  Katalog AD page). A single client's DC being unreachable never blocks the
 *  others — see lib/ad/sync.ts's syncAllAdDirectories. Per-directory actions
 *  (test/sync one) live under /api/directories/[id]/*. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const outcomes = await syncAllAdDirectories();
  for (const o of outcomes) {
    await recordAdHealth(o.directoryId, o.error ? "error" : "ok", o.error || "Połączono z kontrolerem domeny.");
  }

  const failed = outcomes.filter((o) => o.error);
  if (outcomes.length > 0 && failed.length === outcomes.length) {
    const message =
      outcomes.length === 1
        ? failed[0].error!
        : `Żaden z ${failed.length} katalogów AD nie zsynchronizował się.`;
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ success: true, outcomes });
}
