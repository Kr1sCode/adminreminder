"use client"

import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Sun, Moon } from "lucide-react"
import { useEffect, useState } from "react"
import { useT } from "@/components/i18n-provider"

export function ThemeToggle() {
  const t = useT()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Always render the same on server + first client paint (assume light, the default)
  const isDark = !mounted ? false : resolvedTheme === "dark"

  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      onClick={() => {
        if (mounted) {
          setTheme(isDark ? "light" : "dark")
        }
      }}
      title={isDark ? t("theme.toLight") : t("theme.toDark")}
      // Intentionally no `disabled` during SSR/hydration to prevent attribute mismatch
    >
      {isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      <span className="sr-only">{t("theme.toggle")}</span>
    </Button>
  )
}
