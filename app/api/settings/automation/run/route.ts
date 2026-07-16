import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { runScheduledJob, getAutomationState } from "@/lib/scheduler";

/** Manual "run now" from the Automatyzacja tab: full checks + notifications. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const result = await runScheduledJob("manual");
  await recordAudit({
    actor: user,
    action: "item.check_all",
    entityType: "settings",
    details: { zrodlo: "automatyzacja/uruchom-teraz", wynik: result.detail },
  });

  return NextResponse.json({ success: result.ok, detail: result.detail, ...(await getAutomationState()) });
}
