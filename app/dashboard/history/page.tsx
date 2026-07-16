import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { TopNav } from "../top-nav";
import { HistoryClient } from "./history-client";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const user = await requireUser();
  // Entries name people and say which secrets were touched; a viewer has no
  // business here, and the API refuses them anyway.
  if (user.role !== "admin") redirect("/dashboard");

  const t = await getT();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="shrink-0">
        <TopNav user={user} />
      </div>

      <main className="min-h-0 flex-1 w-full px-6 pt-6 pb-3">
        <HistoryClient />
      </main>

      <footer className="shrink-0 w-full px-6 py-3 border-t border-border text-xs text-muted-foreground">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-1">
          <span>{t("hist.footerNote")}</span>
          <span className="whitespace-nowrap">{t("footer.rights")}</span>
        </div>
      </footer>
    </div>
  );
}
