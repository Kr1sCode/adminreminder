import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/components/i18n-provider";
import { DEFAULT_LOCALE, isLocale, createTranslator } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/i18n/locales";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AR - Admin Redminer",
  description: "Admin Redminer – monitor ważności od admina dla admina. Pomysł i wykonanie: www.krzysztofgawkowski.pl",
  icons: {
    icon: "/favicon.ico",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read on the server so the first paint is already in the chosen language.
  const cookieStore = await cookies();
  const stored = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(stored) ? stored : DEFAULT_LOCALE;
  const demoMode = process.env.DEMO_MODE === "true";
  const t = createTranslator(locale);

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <I18nProvider locale={locale}>
            {demoMode && (
              <div className="w-full bg-amber-500 text-black text-center text-xs sm:text-sm font-medium py-1.5 px-4">
                {t("demo.banner")}
              </div>
            )}
            {children}
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
