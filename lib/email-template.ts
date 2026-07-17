/** Notifications go to plain addresses, not to accounts, so they cannot follow
 *  each reader's interface language. One choice serves the whole instance. */
export type EmailLocale = "pl" | "en";

const M = {
  pl: {
    titleBatch: "Powiadomienie o wygasających pozycjach",
    titleSingle: "Powiadomienie o wygasającej pozycji",
    needsAttention: (n: number) => `AdminReminder — ${n === 1 ? "1 pozycja wymaga" : `${n} pozycji wymaga`} uwagi`,
    expired: "Po terminie",
    urgent: "Pilne",
    soon: "Zbliża się termin",
    colItem: "Pozycja",
    colType: "Typ",
    colStatus: "Status",
    colOwner: "Właściciel",
    renew: "odnów",
    open: "Otwórz w AR",
    openText: "Otwórz w AR",
    footer: "Wiadomość wygenerowana automatycznie. Progi powiadomień ustawisz przy każdej pozycji (ikona dzwonka).",
    footerText: "Wiadomość wygenerowana automatycznie.",
    domainOverdue: (d: number) => `NIEOPŁACONA od ${d} dni`,
    certOverdue: (d: number) => `WYGASŁO ${d} dni temu`,
    domainDue: (d: number) => (d === 0 ? "domenę odnów dzisiaj" : d === 1 ? "domenę odnów za 1 dzień" : `domenę odnów za ${d} dni`),
    certDue: (d: number) => (d === 0 ? "wygasa dzisiaj" : d === 1 ? "wygasa za 1 dzień" : `wygasa za ${d} dni`),
  },
  en: {
    titleBatch: "Items approaching expiry",
    titleSingle: "An item is approaching expiry",
    needsAttention: (n: number) => `AdminReminder — ${n === 1 ? "1 item needs" : `${n} items need`} attention`,
    expired: "Overdue",
    urgent: "Urgent",
    soon: "Coming up",
    colItem: "Item",
    colType: "Type",
    colStatus: "Status",
    colOwner: "Owner",
    renew: "renew",
    open: "Open in AR",
    openText: "Open in AR",
    footer: "Sent automatically. Notification thresholds are set per item (the bell icon).",
    footerText: "Sent automatically.",
    domainOverdue: (d: number) => `UNPAID for ${d} days`,
    certOverdue: (d: number) => `EXPIRED ${d} days ago`,
    domainDue: (d: number) => (d === 0 ? "renew the domain today" : d === 1 ? "renew the domain in 1 day" : `renew the domain in ${d} days`),
    certDue: (d: number) => (d === 0 ? "expires today" : d === 1 ? "expires in 1 day" : `expires in ${d} days`),
  },
} as const;

export function emailTitle(kind: "batch" | "single", locale: EmailLocale): string {
  return kind === "batch" ? M[locale].titleBatch : M[locale].titleSingle;
}

/**
 * The notification email. Kept out of lib/email.ts so it renders without a
 * database or a transport, which is what makes it testable.
 *
 * Two rules drive the markup. Item names come from operator input and are
 * interpolated into HTML, so everything is escaped — an item called
 * `Serwer <b>X</b>` must not reformat someone's inbox. And every mail carries a
 * plain-text alternative: clients that refuse HTML then show the content rather
 * than a blank message, and spam filters treat html-only mail with suspicion.
 */

export interface NotifyItem {
  name: string;
  type: string;
  typeLabel?: string;
  identifier: string;
  daysLeft: number;
  owner?: string | null;
  renewalUrl?: string | null;
}

export interface RenderOptions {
  locale?: EmailLocale;
  title?: string;
  /** At or below this many days an item is urgent rather than approaching. */
  urgentDays?: number;
  /** Public address of the instance, for the "open in AR" link. */
  appOrigin?: string | null;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Group {
  key: "expired" | "urgent" | "soon";
  heading: string;
  colour: string;
  items: NotifyItem[];
}

/** Sorted by urgency, because that is the order the reader needs them in. */
function groupByUrgency(items: NotifyItem[], urgentDays: number, locale: EmailLocale): Group[] {
  const groups: Group[] = [
    { key: "expired", heading: M[locale].expired, colour: "#dc2626", items: [] },
    { key: "urgent", heading: M[locale].urgent, colour: "#d97706", items: [] },
    { key: "soon", heading: M[locale].soon, colour: "#0284c7", items: [] },
  ];

  for (const item of items) {
    if (item.daysLeft < 0) groups[0].items.push(item);
    else if (item.daysLeft <= urgentDays) groups[1].items.push(item);
    else groups[2].items.push(item);
  }

  for (const group of groups) group.items.sort((a, b) => a.daysLeft - b.daysLeft);
  return groups.filter((g) => g.items.length > 0);
}

function statusText(item: NotifyItem, locale: EmailLocale): string {
  const m = M[locale];
  const isDomain = item.type === "domain";
  if (item.daysLeft < 0) {
    const overdue = Math.abs(item.daysLeft);
    return isDomain ? m.domainOverdue(overdue) : m.certOverdue(overdue);
  }
  return isDomain ? m.domainDue(item.daysLeft) : m.certDue(item.daysLeft);
}

export function renderNotificationEmail(
  items: NotifyItem[],
  options: RenderOptions = {}
): RenderedEmail {
  const { locale = "pl", urgentDays = 7, appOrigin = null } = options;
  const m = M[locale];
  const title = options.title ?? m.titleBatch;

  const groups = groupByUrgency(items, urgentDays, locale);

  // Light background rather than the old hardcoded dark one: an email cannot ask
  // the client which theme it uses, and dark text on white degrades gracefully
  // everywhere, while white on near-black turns unreadable in a light client.
  const sections = groups
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const name = escapeHtml(item.name);
          const identifier = escapeHtml(item.identifier);
          const type = escapeHtml(item.typeLabel || item.type);
          const owner = item.owner ? escapeHtml(item.owner) : "—";
          const link =
            item.renewalUrl && /^https?:\/\//i.test(item.renewalUrl)
              ? `<a href="${escapeHtml(item.renewalUrl)}" style="color:#0284c7;">${m.renew}</a>`
              : "";

          return `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
                <strong style="color:#111827;">${name}</strong><br>
                <span style="color:#6b7280;font-size:12px;font-family:ui-monospace,monospace;">${identifier}</span>
              </td>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:13px;">${type}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:${group.colour};font-weight:600;font-size:13px;white-space:nowrap;">${escapeHtml(statusText(item, locale))}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:13px;">${owner} ${link}</td>
            </tr>`;
        })
        .join("");

      return `
        <h2 style="margin:28px 0 8px;font-size:15px;color:${group.colour};border-left:4px solid ${group.colour};padding-left:8px;">
          ${escapeHtml(group.heading)} (${group.items.length})
        </h2>
        <table role="presentation" style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:6px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th align="left" style="padding:8px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${m.colItem}</th>
              <th align="left" style="padding:8px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${m.colType}</th>
              <th align="left" style="padding:8px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${m.colStatus}</th>
              <th align="left" style="padding:8px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${m.colOwner}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("");

  const button = appOrigin
    ? `<p style="margin:28px 0 0;">
         <a href="${escapeHtml(appOrigin)}/dashboard"
            style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
           ${m.open}
         </a>
       </p>`
    : "";

  // Logo drawn in HTML/CSS rather than an <img>: data: URIs are blocked by Gmail
  // and an external URL needs hosting and survives image-blocking poorly. A
  // table keeps the badge and wordmark aligned in Outlook too.
  const logo = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border-collapse:collapse;">
      <tr>
        <td style="width:36px;height:36px;background:#059669;border-radius:50%;text-align:center;vertical-align:middle;line-height:36px;font-size:14px;font-weight:700;color:#ffffff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">AR</td>
        <td style="padding-left:10px;font-size:17px;font-weight:700;color:#111827;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;vertical-align:middle;">AdminReminder</td>
      </tr>
    </table>`;

  const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f3f4f6;padding:24px;">
  <div style="max-width:760px;margin:0 auto;background:#f3f4f6;">
    ${logo}
    <h1 style="margin:0 0 4px;font-size:20px;color:#111827;">${escapeHtml(title)}</h1>
    <p style="margin:0;color:#6b7280;font-size:13px;">${escapeHtml(m.needsAttention(items.length))}</p>
    ${sections}
    ${button}
    <p style="margin-top:28px;color:#9ca3af;font-size:12px;">
      ${escapeHtml(m.footer)}
    </p>
  </div>
</div>`.trim();

  const text = [
    title,
    m.needsAttention(items.length),
    "",
    ...groups.flatMap((group) => [
      `${group.heading.toUpperCase()} (${group.items.length})`,
      ...group.items.map(
        (item) => `  - ${item.name} [${item.identifier}] — ${statusText(item, locale)}${item.owner ? ` (${item.owner})` : ""}`
      ),
      "",
    ]),
    appOrigin ? `${m.openText}: ${appOrigin}/dashboard` : "",
    m.footerText,
  ]
    .join("\n")
    .trim();

  return { html, text };
}
