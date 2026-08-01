import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkForUpdate } from "@/lib/update-check";
import { downloadAndInstall, UpdateInstallError } from "@/lib/windows-updater";
import { recordAudit } from "@/lib/audit";

/**
 * Downloads, verifies (against the hash inside the SIGNED manifest) and
 * silently runs the newest installer, then lets the Windows service restart
 * on its own. Re-checks for an update itself (force=true) instead of
 * trusting whatever the browser last saw, so this can never be tricked into
 * installing something by racing a stale client-side cache.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const info = await checkForUpdate(true);
  if (!info?.canAutoInstall) {
    return NextResponse.json(
      { error: "Automatyczna aktualizacja jest niedostępna dla tej instalacji." },
      { status: 400 }
    );
  }

  try {
    await downloadAndInstall(info);
  } catch (err) {
    const message = err instanceof UpdateInstallError ? err.message : "Nie udało się uruchomić aktualizacji.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await recordAudit({
    actor: user,
    action: "system.update",
    entityType: "system",
    entityName: "auto-update",
    details: { do_wersji: info.latestVersion },
  });

  return NextResponse.json({ success: true, version: info.latestVersion });
}
