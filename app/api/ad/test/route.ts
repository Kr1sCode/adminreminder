import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAdConfig } from "@/lib/ad/resolve";
import { adSecurityWarnings, AdConfigError } from "@/lib/ad/config";
import { withServiceBind, searchPaged } from "@/lib/ad/client";

/**
 * Binds with the service account and counts user objects, without writing
 * anything. Lets an admin validate the settings before running a full sync.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  let config;
  try {
    config = await getAdConfig();
  } catch (e: any) {
    const status = e instanceof AdConfigError ? 400 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }

  if (!config) {
    return NextResponse.json({ error: "Uzupełnij adres serwera, konto serwisowe i Base DN." }, { status: 400 });
  }

  try {
    const entries = await withServiceBind(config, (client) =>
      searchPaged(client, config.baseDn, "(&(objectCategory=person)(objectClass=user))", ["sAMAccountName"])
    );

    return NextResponse.json({
      success: true,
      accountsFound: entries.length,
      encrypted: config.encrypted,
      warnings: adSecurityWarnings(config),
    });
  } catch (e: any) {
    console.error("AD test error:", e);
    return NextResponse.json({ error: e.message || "Nie udało się połączyć z kontrolerem domeny" }, { status: 502 });
  }
}
