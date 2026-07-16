import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

/** Presets offered as one-click chips in the UI. A per-item threshold is not
 *  limited to these: an operator may set any number of days for a single item
 *  (it overrides the global policy), so the API validates a range, not this
 *  list. */
export const PRESET_DAYS = [3, 7, 21, 30, 45];
const MAX_DAYS = 3650;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Per-item notification policy: when to alert, until when to stay quiet, and who
 * else to tell. An empty `notificationDays` means "inherit the global setting",
 * which is why null and "" are distinct from a list.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id } = await params;
  const serviceId = parseInt(id);

  const [item] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!item) return NextResponse.json({ error: "Pozycja nie istnieje" }, { status: 404 });

  let body: { days?: number[] | null; mutedUntil?: string | null; recipients?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  // --- progi ---
  let notificationDays: string | null = item.notificationDays;
  if (body.days !== undefined) {
    if (body.days === null || body.days.length === 0) {
      notificationDays = null; // dziedziczy globalne
    } else {
      const invalid = body.days.filter(
        (d) => !Number.isInteger(d) || d < 1 || d > MAX_DAYS
      );
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: `Nieprawidłowe progi: ${invalid.join(", ")}. Podaj liczbę dni od 1 do ${MAX_DAYS}.` },
          { status: 400 }
        );
      }
      notificationDays = [...new Set(body.days)].sort((a, b) => a - b).join(",");
    }
  }

  // --- wyciszenie ---
  let mutedUntil: Date | null = item.mutedUntil;
  if (body.mutedUntil !== undefined) {
    if (!body.mutedUntil) {
      mutedUntil = null;
    } else {
      // The date picker yields a day, and the operator means "quiet through that
      // day", so the mute expires as it ends rather than as it begins.
      const parsed = new Date(`${body.mutedUntil}T23:59:59.999Z`);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "Nieprawidłowa data wyciszenia" }, { status: 400 });
      }
      mutedUntil = parsed;
    }
  }

  // --- dodatkowi odbiorcy ---
  let notifyRecipients: string | null = item.notifyRecipients;
  if (body.recipients !== undefined) {
    const list = (body.recipients || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const bad = list.filter((e) => !EMAIL.test(e));
    if (bad.length > 0) {
      return NextResponse.json({ error: `Nieprawidłowy adres: ${bad[0]}` }, { status: 400 });
    }
    notifyRecipients = list.length > 0 ? list.join(",") : null;
  }

  // Changing the thresholds invalidates the record of which ones already fired:
  // a newly added 45-day alert must be allowed to go out, and a removed one must
  // not linger. Cheaper to clear than to reconcile.
  const daysChanged = notificationDays !== item.notificationDays;

  await db
    .update(services)
    .set({
      notificationDays,
      mutedUntil,
      notifyRecipients,
      ...(daysChanged ? { notifiedThresholds: [] } : {}),
      updatedAt: new Date(),
    })
    .where(eq(services.id, serviceId));

  await recordAudit({
    actor: user,
    action: "item.notifications",
    entityType: "service",
    entityId: serviceId,
    entityName: item.name,
    details: {
      progi: notificationDays ?? "(globalne)",
      wyciszone_do: mutedUntil?.toISOString() ?? null,
      dodatkowi_odbiorcy: notifyRecipients ?? null,
    },
  });

  return NextResponse.json({
    success: true,
    notificationDays,
    mutedUntil: mutedUntil?.toISOString() ?? null,
    notifyRecipients,
    thresholdsReset: daysChanged,
  });
}
