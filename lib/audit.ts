import { db } from "./db";
import { auditLog, type AuditAction } from "@/db/schema";

/**
 * Records what a person did. Automatic work — the cron's checks and syncs — is
 * deliberately absent: it touches every row several times a day, and the noise
 * would bury the single human action an auditor is looking for.
 *
 * Never throws. A failed audit write must not abort the operation it describes,
 * or the log becomes a way to break the app.
 */

export interface Actor {
  id?: number;
  username: string;
  role?: string;
}

export interface AuditInput {
  actor: Actor;
  action: AuditAction;
  entityType?: string;
  entityId?: number;
  entityName?: string;
  details?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLog).values({
      at: new Date(),
      actorId: input.actor.id ?? null,
      actorName: input.actor.username,
      actorRole: input.actor.role ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      entityName: input.entityName ?? null,
      details: input.details ?? null,
    });
  } catch (err) {
    console.error("[audit] nie udało się zapisać wpisu:", err);
  }
}

/** Keys whose values must never reach the log, whatever the caller passes. */
const SECRET_LIKE = /(secret|password|pass|token|key|hash)/i;

/**
 * Field-level before/after for an update, skipping unchanged fields. Values of
 * secret-like fields collapse to a marker: the log records *that* a password
 * changed, never *to what*.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[]
): Record<string, { z: unknown; na: unknown }> {
  const changes: Record<string, { z: unknown; na: unknown }> = {};

  for (const field of fields) {
    const from = normalise(before[field]);
    const to = normalise(after[field]);
    if (from === to) continue;

    changes[field] = SECRET_LIKE.test(field)
      ? { z: "(ukryte)", na: "(zmienione)" }
      : { z: from, na: to };
  }
  return changes;
}

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}
