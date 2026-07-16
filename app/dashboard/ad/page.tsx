import { requireUser } from "@/lib/auth";
import { TopNav } from "../top-nav";
import { AdClient, AD_FOOTER_SLOT_ID } from "./ad-client";
import { getAdThresholds } from "@/lib/settings";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdDirectoryPage() {
  const user = await requireUser();
  const t = await getT();

  // One fallback per clock (Ustawienia → Active Directory). An OU or account with
  // no thresholds of its own inherits these, and the panel says so.
  const globalDays = await getAdThresholds();

  return (
    // Laid out like the dashboard: the window never scrolls, the nav and the
    // footer keep their size, and the directory takes whatever is left and
    // scrolls on its own. No page heading — the nav already says where you are,
    // and the row it saves goes to the accounts.
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="shrink-0">
        <TopNav user={user} />
      </div>

      <main className="min-h-0 flex-1 w-full px-6 pt-6 pb-3">
        <AdClient isAdmin={user.role === "admin"} globalDays={globalDays} />
      </main>

      <footer className="shrink-0 w-full px-6 py-3 border-t border-border text-xs text-muted-foreground">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-1">
          {/* Filled by AdClient through a portal: the sync time lives in the
              client's state, and a line of its own above the footer would double
              the height of the page's bottom edge. */}
          <span id={AD_FOOTER_SLOT_ID} className="min-w-0 truncate" />
          <span className="whitespace-nowrap">{t("footer.rights")}</span>
        </div>
      </footer>
    </div>
  );
}
