import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sendWebhook } from "@/lib/webhook";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const result = await sendWebhook([
    { name: "Przykładowa pozycja", type: "https_cert", identifier: "example.com", daysLeft: 7, status: "expiring" },
  ]);

  return NextResponse.json(result);
}
