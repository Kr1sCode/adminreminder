import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAdHealth } from "@/lib/ad/health";

/**
 * Cached-only read — never opens an LDAP connection itself. The scheduler
 * (lib/scheduler.ts tick, every 30s, rate-limited to once per 5 min) and the
 * test/sync routes are what actually probe AD; this just reports what they
 * last found, so the Ustawienia page can show a light without hammering the
 * domain controller on every render.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const health = await getAdHealth();
  return NextResponse.json({ health });
}
