import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { syncAllEntraDirectories } from "@/lib/azure/users-sync";
import { isAzureConfigured } from "@/lib/azure/graph";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ configured: await isAzureConfigured() });
}

/** Syncs accounts for every enabled Entra directory (used by the
 *  "Synchronizuj" button on the Katalog AD page, alongside /api/ad/sync). */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const outcomes = await syncAllEntraDirectories();
  const failed = outcomes.filter((o) => o.error);
  if (outcomes.length > 0 && failed.length === outcomes.length) {
    const message =
      outcomes.length === 1 ? failed[0].error! : `Żaden z ${failed.length} tenantów Entra nie zsynchronizował się.`;
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ success: true, outcomes });
}
