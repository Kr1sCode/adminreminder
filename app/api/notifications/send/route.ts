import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sendNotifications } from "@/lib/notify";
import { sendAdAccountNotifications } from "@/lib/ad/notify-accounts";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const items = await sendNotifications();
  const adAccounts = await sendAdAccountNotifications();

  // One button, one number: the operator asked "send what is due", and expiring
  // account passwords are due in the same sense as an expiring certificate.
  return NextResponse.json({
    ...items,
    success: items.success || adAccounts.success,
    sent: (items.sent ?? 0) + (adAccounts.sent ?? 0),
    adAccounts,
  });
}
