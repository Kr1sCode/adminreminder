"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Element rendered by TopNav; the pills are teleported into it. */
export const NAV_STATS_SLOT_ID = "nav-stats-slot";

/**
 * Counters live in the page's client state — they change when the list is
 * refreshed — while the navigation bar is rendered by the server layout above
 * it. A portal lets the page own the numbers and the bar own the position,
 * without threading state through a shared parent.
 *
 * More pills than fit are reached with the arrows at either end, not with a
 * scrollbar: a horizontal bar under the row steals height from a 64px navbar and
 * squashes the pills it is supposed to serve. The track still scrolls — it is
 * just driven by the buttons, and the arrows appear only when there is somewhere
 * to go.
 *
 * Renders nothing until mounted, because the slot does not exist during SSR.
 */
export function NavStats({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    setSlot(document.getElementById(NAV_STATS_SLOT_ID));
  }, []);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    // A sub-pixel slack: a fractional layout width must not leave an arrow lit
    // with nothing behind it.
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The pills themselves change width when a counter goes from 9 to 10.
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => observer.disconnect();
  }, [measure, children]);

  if (!slot) return null;

  const scroll = (direction: -1 | 1) =>
    track.current?.scrollBy({ left: direction * 200, behavior: "smooth" });

  const arrow = (direction: -1 | 1, enabled: boolean) => (
    <button
      type="button"
      onClick={() => scroll(direction)}
      aria-label={direction === -1 ? "Poprzednie liczniki" : "Następne liczniki"}
      className={`shrink-0 rounded-md border border-border bg-muted/40 p-1 text-muted-foreground transition-opacity hover:text-foreground ${
        enabled ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      {direction === -1 ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
  );

  return createPortal(
    <>
      {arrow(-1, canScrollLeft)}

      {/* overflow-hidden, not auto: scrollLeft still moves under the arrows'
          control, but no scrollbar is drawn and no height is lost to it. */}
      <div
        ref={track}
        onScroll={measure}
        className="flex items-center gap-2 min-w-0 overflow-hidden"
      >
        {children}
      </div>

      {arrow(1, canScrollRight)}
    </>,
    slot
  );
}

export function StatPill({
  label,
  value,
  color = "text-foreground",
  title,
}: {
  label: string;
  value: number;
  color?: string;
  title?: string;
}) {
  // Square corners on purpose: a pill reads as something you can press, and
  // these are read-outs. Same reason there is no hover state.
  return (
    <span
      title={title ?? label}
      className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 whitespace-nowrap select-none"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-base font-semibold leading-none tabular-nums ${color}`}>{value}</span>
    </span>
  );
}
