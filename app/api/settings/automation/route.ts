import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { getAutomationState, validateCron, nextRuns } from "@/lib/scheduler";

/**
 * GET            → current automation state (enabled, cron, next runs, last run)
 * GET ?preview=… → dry-run: validity + next runs for an arbitrary expression,
 *                  so the builder can show a live preview before saving.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const preview = request.nextUrl.searchParams.get("preview");
  if (preview !== null) {
    const v = validateCron(preview);
    return NextResponse.json({
      valid: v.ok,
      error: v.error ?? null,
      nextRuns: v.ok ? nextRuns(preview, new Date(), 3).map((d) => d.getTime()) : [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  return NextResponse.json(await getAutomationState());
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const enabled = body.enabled === true || body.enabled === "true";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";

    const v = validateCron(cron);
    if (!v.ok) {
      return NextResponse.json({ error: `Nieprawidłowe wyrażenie cron: ${v.error}` }, { status: 400 });
    }

    await setSetting("automation_cron", cron);
    await setSetting("automation_enabled", enabled ? "true" : "false");

    await recordAudit({
      actor: user,
      action: "settings.update",
      entityType: "settings",
      details: { zmienione_klucze: ["automation_enabled", "automation_cron"], harmonogram: cron, wlaczony: enabled },
    });

    return NextResponse.json({ success: true, ...(await getAutomationState()) });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Błąd zapisu harmonogramu" }, { status: 500 });
  }
}
