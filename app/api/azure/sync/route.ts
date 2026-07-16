import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { syncAzureCredentials } from "@/lib/azure/sync";
import { isAzureConfigured } from "@/lib/azure/graph";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ configured: await isAzureConfigured() });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  try {
    const result = await syncAzureCredentials();
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    console.error("Azure sync error:", e);
    return NextResponse.json({ error: e.message || "Błąd synchronizacji z Azure" }, { status: 500 });
  }
}
