import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkForUpdate } from "@/lib/update-check";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const force = request.nextUrl.searchParams.get("force") === "1";
  const info = await checkForUpdate(force);
  return NextResponse.json(info ?? { available: false });
}
