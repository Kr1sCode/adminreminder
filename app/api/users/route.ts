import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getCurrentUser, createUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { eq } from "drizzle-orm";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      authSource: users.authSource,
      mfaEnabled: users.mfaEnabled,
      mfaRequired: users.mfaRequired,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);

  return NextResponse.json(allUsers);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  try {
    const { username, password, role } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Nazwa użytkownika i hasło są wymagane" }, { status: 400 });
    }

    const result = await createUser(username, password, role || "viewer");

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await recordAudit({
      actor: user,
      action: "user.create",
      entityType: "user",
      entityId: result.user?.id,
      entityName: username,
      details: { rola: role || "viewer" },
    });

    return NextResponse.json({ success: true, user: result.user });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Błąd podczas tworzenia użytkownika" }, { status: 500 });
  }
}
