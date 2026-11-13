// The shell's single layout grid (overhaul-facet-shell-ia-and-space D1).
//
// Before this, every view picked its own width — intro/docs centered at
// max-w-3xl (768px) inside a full-width main, the MCP depth view at max-w-6xl,
// and the listing views unbounded single columns. The result was two kinds of
// waste at once: content pages left ~550px empty on each side of a 1920 screen,
// and listing rows stretched a single line of text across the whole viewport.
//
// Two widths, one meaning each:
//   wide  — listing surfaces and work areas: fills the container, tiles.
//   split — content surfaces: a navigational rail beside a reading measure.
//            The margins become the rail instead of empty space.
//
// Both cap at 1600px: past that, more pixels stop helping legibility.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const MAX = "max-w-[1600px]";

export function Container({
  variant = "wide",
  className,
  children,
}: {
  variant?: "wide" | "split";
  className?: string;
  children: ReactNode;
}) {
  if (variant === "split") {
    return (
      <div
        data-testid="facet-container"
        data-variant="split"
        className={cn("mx-auto grid w-full gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]", MAX, className)}
      >
        {children}
      </div>
    );
  }
  return (
    <div data-testid="facet-container" data-variant="wide" className={cn("mx-auto w-full", MAX, className)}>
      {children}
    </div>
  );
}

/** The left column of a split container: navigation, filters, or a table of
 *  contents. Sticky on wide viewports, collapsed above the body on narrow. */
export function Rail({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <aside
      data-testid="facet-rail"
      className={cn("min-w-0 lg:sticky lg:top-0 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-auto", className)}
    >
      {children}
    </aside>
  );
}

/** The reading column of a split container. Capped for line length, aligned
 *  left against the rail (never centered — centering was the old waste). */
export function Measure({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-testid="facet-measure" className={cn("min-w-0 w-full max-w-4xl", className)}>
      {children}
    </div>
  );
}
