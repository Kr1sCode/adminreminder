"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuGroup,
  DropdownMenuItem, 
  DropdownMenuLabel, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { User, LogOut, Shield, Settings, LayoutDashboard, Network, History } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { NAV_STATS_SLOT_ID } from "@/components/nav-stats";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useT } from "@/components/i18n-provider";

interface Props {
  user: {
    username: string;
    role: "admin" | "viewer";
  };
}

export function TopNav({ user }: Props) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const isAdmin = user.role === "admin";

  const links = [
    { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
    { href: "/dashboard/ad", label: t("nav.ad"), icon: Network },
    // Admin-only: entries name people and say which secrets were touched.
    ...(isAdmin ? [{ href: "/dashboard/history", label: t("nav.history"), icon: History }] : []),
    ...(isAdmin ? [{ href: "/dashboard/settings", label: t("nav.settings"), icon: Settings }] : []),
  ];

  return (
    <nav className="border-b border-border bg-background/95 backdrop-blur sticky top-0 z-50">
      <div className="w-full px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-6 shrink-0">
          <Link href="/dashboard">
            <Logo size="sm" />
          </Link>

          <div className="flex items-center gap-1 text-sm">
            {links.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Filled by the current page through a portal (see components/nav-stats).
            Hidden on narrow screens: the counters are a convenience, the links
            and the account menu are not.

            Two nested boxes on purpose. The outer one owns the space and clips;
            the inner one holds the pills, which NavStats moves with the arrows at
            either end. With the pills alone in a `justify-end` box they overflow
            towards the *start* — i.e. leftwards, straight over the navigation
            links — however many of them a page decides to render. */}
        <div className="hidden 2xl:flex flex-1 min-w-0 justify-end mr-6 overflow-hidden">
          <div
            id={NAV_STATS_SLOT_ID}
            className="flex items-center gap-2 max-w-full min-w-0"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <LanguageSwitcher />
          <ThemeToggle />

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted border border-border text-sm">
            {isAdmin ? (
              <Shield className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <User className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="text-foreground">{user.username}</span>
            <span className="text-[10px] px-1.5 py-px rounded bg-muted-foreground/30 text-muted-foreground uppercase tracking-widest">
              {user.role}
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger>
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <User className="h-4 w-4" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("nav.account")}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isAdmin && (
                  <DropdownMenuItem onClick={() => router.push("/dashboard/settings")} className="cursor-pointer">
                    <Settings className="mr-2 h-4 w-4" />
                    {t("nav.adminSettings")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={handleLogout} className="text-red-400 focus:text-red-400 cursor-pointer">
                  <LogOut className="mr-2 h-4 w-4" />
                  {t("nav.logout")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </nav>
  );
}
