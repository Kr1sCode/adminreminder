/**
 * CSV for spreadsheets, not for parsers.
 *
 * Two things make a naive join(",") wrong here. Excel in a Polish locale reads
 * the semicolon as the column separator and treats a comma as a decimal point,
 * so a comma-delimited file lands in one column. And a cell beginning with
 * `=`, `+`, `-` or `@` is executed as a formula on open — an item named
 * `=cmd|'/c calc'!A1` is a live attack on whoever opens the export.
 *
 * Pure and dependency-free, so the escaping can be tested on its own.
 */

const DELIMITER = ";";

/** Excel decides the encoding from this; without it Polish characters break. */
const BOM = "﻿";

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text = value instanceof Date ? value.toISOString() : String(value);

  // Formula injection: the leading apostrophe makes a spreadsheet treat the rest
  // as text. Harmless in a plain-text reader, which shows the quote and moves on.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (text.includes('"') || text.includes(DELIMITER) || /[\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(escapeCell).join(DELIMITER),
    ...rows.map((row) => row.map(escapeCell).join(DELIMITER)),
  ];
  // CRLF: what every spreadsheet expects, and what RFC 4180 asks for.
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Names a download after the day it was taken: ar-pozycje-2026-07-10.csv */
export function csvFilename(prefix: string, now: Date = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}
