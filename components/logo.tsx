import { cn } from "@/lib/utils"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  className?: string
  showTagline?: boolean
}

export function Logo({ size = "md", className, showTagline = false }: LogoProps) {
  const sizes = {
    sm: {
      icon: "h-7 w-7",
      text: "text-lg",
      ar: "text-[17px]",
    },
    md: {
      icon: "h-9 w-9",
      text: "text-2xl",
      ar: "text-[21px]",
    },
    lg: {
      icon: "h-11 w-11",
      text: "text-3xl",
      ar: "text-[26px]",
    },
  }

  const s = sizes[size]

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className={cn(
        "flex items-center justify-center rounded-2xl bg-emerald-500 shadow-sm",
        s.icon
      )}>
        <span className={cn(
          "font-black text-white tracking-[-1.5px] leading-none",
          s.ar
        )}>
          AR
        </span>
      </div>
      <div className="flex flex-col leading-none">
        <span className={cn("font-semibold tracking-[-0.6px] text-foreground", s.text)}>
          Admin Redminer
        </span>
        {showTagline && (
          <span className="text-[10px] text-muted-foreground mt-0.5 tracking-normal">
            by krzysztofgawkowski.pl
          </span>
        )}
      </div>
    </div>
  )
}
