import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDirectory } from "@/lib/directories";
import { getAdConfigById } from "@/lib/ad/resolve";
import { getAzureConfigById, listUsers } from "@/lib/azure/graph";
import { adSecurityWarnings } from "@/lib/ad/config";
import { withServiceBind, searchPaged } from "@/lib/ad/client";
import { recordAdHealth } from "@/lib/ad/health";

/**
 * Validates one directory's credentials without writing anything: an AD bind
 * that counts user objects, or a single paged Graph /users call for Entra.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  const directory = await getDirectory(id);
  if (!directory) return NextResponse.json({ error: "Katalog nie istnieje" }, { status: 404 });

  if (directory.type === "ad") {
    const config = await getAdConfigById(id);
    if (!config) {
      return NextResponse.json({ error: "Uzupełnij adres serwera, konto serwisowe i Base DN." }, { status: 400 });
    }
    try {
      const entries = await withServiceBind(config, (client) =>
        searchPaged(client, config.baseDn, "(&(objectCategory=person)(objectClass=user))", ["sAMAccountName"])
      );
      await recordAdHealth(id, "ok", "Połączono z kontrolerem domeny.");
      return NextResponse.json({
        success: true,
        accountsFound: entries.length,
        encrypted: config.encrypted,
        warnings: adSecurityWarnings(config),
      });
    } catch (e: any) {
      const message = e.message || "Nie udało się połączyć z kontrolerem domeny";
      await recordAdHealth(id, "error", message);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const config = await getAzureConfigById(id);
  if (!config) {
    return NextResponse.json({ error: "Uzupełnij Tenant ID, Client ID i Client Secret." }, { status: 400 });
  }
  try {
    // Pulling one entry is enough to prove the credentials and permissions
    // work — fetching every user just to test a connection would be wasteful
    // on a large tenant, unlike the AD test above (one LDAP search either way).
    const iterator = listUsers(config)[Symbol.asyncIterator]();
    await iterator.next();
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się połączyć z Graph API" }, { status: 502 });
  }
}
