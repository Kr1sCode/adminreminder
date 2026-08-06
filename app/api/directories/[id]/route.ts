import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adAccounts, adNotifyPolicies, services, directories } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  getDirectory,
  toPublicDirectory,
  buildDirectoryValues,
  DirectoryValidationError,
  type DirectoryInput,
} from "@/lib/directories";

async function requireAdminAndDirectory(id: number) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return { error: NextResponse.json({ error: "Tylko administrator" }, { status: 403 }) } as const;
  }
  const directory = await getDirectory(id);
  if (!directory) {
    return { error: NextResponse.json({ error: "Katalog nie istnieje" }, { status: 404 }) } as const;
  }
  return { user, directory } as const;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  const check = await requireAdminAndDirectory(id);
  if ("error" in check) return check.error;

  return NextResponse.json({ directory: toPublicDirectory(check.directory) });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  const check = await requireAdminAndDirectory(id);
  if ("error" in check) return check.error;
  const { user, directory } = check;

  let body: DirectoryInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  // The type a directory was created with never changes — switching an AD row
  // to Entra (or vice versa) would orphan every account it already synced.
  if (body.type && body.type !== directory.type) {
    return NextResponse.json({ error: "Nie można zmienić typu istniejącego katalogu." }, { status: 400 });
  }

  let values;
  try {
    values = buildDirectoryValues(directory, body);
  } catch (e) {
    if (e instanceof DirectoryValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const [updated] = await db.update(directories).set(values).where(eq(directories.id, id)).returning();

  await recordAudit({
    actor: user,
    action: "settings.update",
    entityType: "directory",
    entityId: id,
    entityName: updated.label,
    details: { zaktualizowano: true },
  });

  return NextResponse.json({ success: true, directory: toPublicDirectory(updated) });
}

/**
 * Removes a directory and everything sync ever wrote for it — the account
 * mirror, its notification policies and any adcs/Azure-credential rows are
 * all just a reproducible result of syncing that connection, safe to drop.
 * The primary AD (the one AdminReminder logs into) can never be deleted here.
 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  const check = await requireAdminAndDirectory(id);
  if ("error" in check) return check.error;
  const { user, directory } = check;

  if (directory.isPrimary) {
    return NextResponse.json(
      { error: "Nie można usunąć głównego AD — to jest katalog, przez który logujesz się do AdminRemindera." },
      { status: 400 }
    );
  }

  await db.delete(adAccounts).where(eq(adAccounts.directoryId, id));
  await db.delete(adNotifyPolicies).where(eq(adNotifyPolicies.directoryId, id));
  await db.delete(services).where(eq(services.directoryId, id));
  await db.delete(directories).where(eq(directories.id, id));

  await recordAudit({
    actor: user,
    action: "settings.update",
    entityType: "directory",
    entityId: id,
    entityName: directory.label,
    details: { usunieto: true, typ: directory.type },
  });

  return NextResponse.json({ success: true });
}
