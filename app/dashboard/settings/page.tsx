import { requireAdmin } from "@/lib/auth";
import { getAllSettings } from "@/lib/settings";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { SettingsClient } from "./settings-client";
import { TopNav } from "../top-nav";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireAdmin();
  const t = await getT();

  const currentSettings = await getAllSettings();

  // Load users (admin only view)
  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      authSource: users.authSource,
      mfaEnabled: users.mfaEnabled,
      mfaRequired: users.mfaRequired,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);

  return (
    <div className="min-h-screen bg-background">
      <TopNav user={admin} />

      <div className="w-full px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">{t("settings.pageTitle")}</h1>
          <p className="text-muted-foreground mt-1">
            {t("settings.pageSubtitle")}
          </p>
        </div>

        <SettingsClient
          initialSettings={currentSettings}
          initialUsers={allUsers}
          currentAdminId={admin.id}
        />
      </div>
    </div>
  );
}
