import type { AdAccountKind } from "@/db/schema";

export interface ClassificationRules {
  technicalOus: string[];
  technicalPatterns: string[];
  functionalOus: string[];
  functionalPatterns: string[];
}

export interface ClassificationInput {
  samAccountName: string;
  distinguishedName: string;
}

export interface Classification {
  kind: AdAccountKind;
  reason: string | null;
}

/** Splits a textarea/CSV settings value into trimmed, non-empty entries. */
export function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const normalizeDn = (dn: string) => dn.replace(/\s*,\s*/g, ",").toLowerCase();

/** True when the account's DN sits inside (at any depth) the given container. */
function isInsideOu(distinguishedName: string, ouDn: string): boolean {
  const account = normalizeDn(distinguishedName);
  const container = normalizeDn(ouDn);
  return account.endsWith(`,${container}`) || account === container;
}

/** Converts a `svc-*` style glob into an anchored, case-insensitive regex. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

function matchesAnyPattern(samAccountName: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (globToRegex(pattern).test(samAccountName)) return pattern;
  }
  return null;
}

function matchesAnyOu(distinguishedName: string, ous: string[]): string | null {
  for (const ou of ous) {
    if (isInsideOu(distinguishedName, ou)) return ou;
  }
  return null;
}

/**
 * OU membership wins over the naming convention: a deliberate placement in the
 * directory is a stronger signal than a prefix somebody may have typed by habit.
 */
export function classifyAccount(
  account: ClassificationInput,
  rules: ClassificationRules
): Classification {
  const ouTechnical = matchesAnyOu(account.distinguishedName, rules.technicalOus);
  if (ouTechnical) return { kind: "technical", reason: `W kontenerze ${ouTechnical}` };

  const ouFunctional = matchesAnyOu(account.distinguishedName, rules.functionalOus);
  if (ouFunctional) return { kind: "functional", reason: `W kontenerze ${ouFunctional}` };

  const nameTechnical = matchesAnyPattern(account.samAccountName, rules.technicalPatterns);
  if (nameTechnical) return { kind: "technical", reason: `Pasuje do wzorca ${nameTechnical}` };

  const nameFunctional = matchesAnyPattern(account.samAccountName, rules.functionalPatterns);
  if (nameFunctional) return { kind: "functional", reason: `Pasuje do wzorca ${nameFunctional}` };

  return { kind: "user", reason: null };
}
