import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLog } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { and, desc, eq, gte, lte, like, or, sql, type SQL } from "drizzle-orm";

const PAGE_SIZE = 50;

/**
 * The change log, filtered along the axes an auditor actually asks about: who
 * did it, what they did, to which item, and when.
 *
 * Admin-only. Entries name people and reveal which secrets were touched (never
 * their values), which is more than a viewer needs to see.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const p = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(p.get("page") || "1", 10));
  const conditions: SQL[] = [];

  const actor = p.get("actor");
  if (actor && actor !== "all") conditions.push(eq(auditLog.actorName, actor));

  const action = p.get("action");
  if (action && action !== "all") conditions.push(eq(auditLog.action, action as never));

  const entityType = p.get("entityType");
  if (entityType && entityType !== "all") conditions.push(eq(auditLog.entityType, entityType));

  const from = p.get("from");
  if (from) conditions.push(gte(auditLog.at, new Date(`${from}T00:00:00.000Z`)));

  const to = p.get("to");
  if (to) conditions.push(lte(auditLog.at, new Date(`${to}T23:59:59.999Z`)));

  // Free text spans the item name and the actor: "kto" and "gdzie" in one box.
  const q = p.get("q")?.trim();
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      or(like(auditLog.entityName, pattern), like(auditLog.actorName, pattern)) as SQL
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLog)
    .where(where);

  const entries = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  // Distinct actors, so the filter offers the people who are actually in the log
  // rather than the accounts that happen to exist today.
  const actors = await db
    .selectDistinct({ name: auditLog.actorName })
    .from(auditLog)
    .orderBy(auditLog.actorName);

  return NextResponse.json({
    entries,
    total: count,
    page,
    pageSize: PAGE_SIZE,
    pages: Math.max(1, Math.ceil(count / PAGE_SIZE)),
    actors: actors.map((a) => a.name),
  });
}
