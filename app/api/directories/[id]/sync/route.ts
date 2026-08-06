import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDirectory } from "@/lib/directories";
import { runDirectorySync } from "@/lib/directory-sync";

/** Syncs exactly one directory now, regardless of its own syncCron — the
 *  per-row "Synchronizuj" action in the settings list. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  const directory = await getDirectory(id);
  if (!directory) return NextResponse.json({ error: "Katalog nie istnieje" }, { status: 404 });

  await runDirectorySync(directory);

  const after = await getDirectory(id);
  if (after?.lastSyncStatus === "error") {
    return NextResponse.json({ error: after.lastSyncDetail || "Błąd synchronizacji" }, { status: 500 });
  }

  return NextResponse.json({ success: true, detail: after?.lastSyncDetail ?? null });
}
