import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { directories } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  listDirectories,
  toPublicDirectory,
  buildDirectoryValues,
  DirectoryValidationError,
  type DirectoryInput,
} from "@/lib/directories";

/**
 * Every configured AD forest / Entra tenant. Available to any signed-in user
 * (viewers need the list for the directory filter on Katalog AD) — secrets
 * are always masked regardless of role, same convention as GET /api/settings.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await listDirectories();
  return NextResponse.json({ directories: rows.map(toPublicDirectory) });
}

/**
 * Adds a new directory. The very first AD directory ever configured becomes
 * the primary one — the only directory AdminReminder itself binds against to
 * authenticate a login — every AD directory added afterward is pure read-only
 * inventory. Entra directories never become primary; Entra has no login path.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  let body: DirectoryInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  let values;
  try {
    values = buildDirectoryValues(null, body);
  } catch (e) {
    if (e instanceof DirectoryValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const isPrimary =
    values.type === "ad" && (await db.select().from(directories).where(eq(directories.type, "ad"))).length === 0;

  const [created] = await db
    .insert(directories)
    .values({ ...values, isPrimary })
    .returning();

  await recordAudit({
    actor: user,
    action: "settings.update",
    entityType: "directory",
    entityId: created.id,
    entityName: created.label,
    details: { utworzono: true, typ: created.type, glowny: isPrimary },
  });

  return NextResponse.json({ success: true, directory: toPublicDirectory(created) });
}
