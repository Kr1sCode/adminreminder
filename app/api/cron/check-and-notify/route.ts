import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runChecks } from "@/lib/check";
import { syncAllDirectoriesNow } from "@/lib/directory-sync";
import { sendNotifications } from "@/lib/notify";
import { sendAdAccountNotifications } from "@/lib/ad/notify-accounts";

/** Constant-time comparison so a caller cannot probe the secret byte by byte. */
function secretMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authHeader);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;

  if (!secret || !secretMatches(authHeader, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // An external cron hitting this endpoint means "do everything now" — same
    // as the manual "run now" button, it force-syncs every directory rather
    // than waiting for each one's own syncCron (that cadence is only honoured
    // by the in-app scheduler's autonomous tick, see lib/scheduler.ts).
    await syncAllDirectoriesNow();
    const checkResult = await runChecks();
    const notifyResult = await sendNotifications();
    const adResult = await sendAdAccountNotifications();

    return NextResponse.json({
      success: true,
      checks: checkResult,
      notifications: notifyResult,
      adAccounts: adResult,
    });
  } catch (error: any) {
    console.error("Cron error:", error);
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}

// Also support POST for some cron services
export async function POST(request: NextRequest) {
  return GET(request);
}
