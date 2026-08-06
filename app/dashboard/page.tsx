import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { services, ITEM_TYPE_LABELS } from "@/db/schema";
import { desc } from "drizzle-orm";
import { DashboardClient } from "./dashboard-client";
import { computeStatus } from "@/lib/cert-checker";
import { TopNav } from "./top-nav";
import { getSetting, getThresholds } from "@/lib/settings";
import { computeStats } from "@/lib/dashboard-stats";
import { getT } from "@/lib/i18n/server";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();

  const { expiringSoonDays, urgentDays } = await getThresholds();
  const t = await getT();

  // Items with no policy of their own inherit this; the panel shows it as such.
  const globalNotificationDays = ((await getSetting("notification_days", "3,7,21")) || "3,7,21")
    .split(",")
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d) && d > 0);

  // Load all tracked items (certificates, warranties, Azure tokens, etc.)
  const allItems = await db
    .select()
    .from(services)
    .orderBy(desc(services.expiryDate));

  // Enrich with computed status using admin-configured thresholds. Must stay in
  // step with GET /api/services, which the client refetches over this payload.
  const enriched = allItems.map((item) => {
    const cert = computeStatus(item.expiryDate ? new Date(item.expiryDate) : null, expiringSoonDays);
    const domain = item.domainName
      ? computeStatus(item.domainExpiryDate ? new Date(item.domainExpiryDate) : null, expiringSoonDays)
      : null;

    return {
      ...item,
      computedStatus: cert.status,
      daysLeft: cert.daysLeft,
      domainStatus: domain?.status ?? null,
      domainDaysLeft: domain?.daysLeft ?? null,
      typeLabel: ITEM_TYPE_LABELS[item.type as keyof typeof ITEM_TYPE_LABELS] || item.type,
    };
  });

  // One row = one count; an item's status is the more urgent of its cert/domain.
  const stats = computeStats(enriched);

  return (
    // The window never scrolls: the nav and the footer are fixed in size and the
    // table takes whatever is left, scrolling on its own.
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="shrink-0">
        <TopNav user={user} />
      </div>

      <main className="min-h-0 flex-1 w-full px-6 pt-6 pb-3">
        <DashboardClient
          initialItems={enriched}
          stats={stats}
          currentUser={user}
          globalNotificationDays={globalNotificationDays}
          urgentDays={urgentDays}
        />
      </main>

      <footer className="shrink-0 w-full px-6 py-3 border-t border-border text-xs text-muted-foreground">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-1">
          <span>{t("footer.autoCheck")}</span>
          <span className="whitespace-nowrap">
            {t("footer.rights")} · {t("footer.version", { version: pkg.version })}
          </span>
        </div>
      </footer>
    </div>
  );
}
