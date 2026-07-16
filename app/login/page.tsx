import { redirect } from "next/navigation";
import { getCurrentUser, login, createUser, needsSetup } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { Logo } from "@/components/logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getT } from "@/lib/i18n/server";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  const isFirstRun = await needsSetup();
  const t = await getT();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      {/* Before signing in there is no navigation bar, and the language must still
          be reachable — otherwise the first screen is the only untranslatable one. */}
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <Logo size="lg" showTagline className="mb-4" />
          <p className="text-muted-foreground text-center max-w-[300px]">
            {isFirstRun ? t("login.pageWelcome") : t("login.pageSubtitle")}
          </p>
        </div>

        <LoginForm isFirstRun={isFirstRun} />

        <p className="text-center text-xs text-muted-foreground mt-8">
          Admin Redminer – monitor ważności od admina dla admina. Pomysł i wykonanie: www.krzysztofgawkowski.pl
        </p>
      </div>
    </div>
  );
}
