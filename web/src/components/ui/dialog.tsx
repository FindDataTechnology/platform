import * as React from "react"
import { cn } from "@/lib/utils"

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)
  // Callers pass `onOpenChange` as an inline arrow, so it is a new function on
  // every parent render — and a form's parent re-renders on every keystroke.
  // Depending on it directly ran the effect below per character: the cleanup
  // restored focus to the opener and the re-run stole it to the FIRST field, so
  // typing in any dialog input jumped the caret out of that input. Hold it in a
  // ref so the effect can depend on `open` alone and mount exactly once.
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  // Stable identity: the focus-trap effect below depends on this, and it only
  // ever reads rootRef (a ref), so it never goes stale.
  const focusables = React.useCallback(
    () =>
      rootRef.current
        ? Array.from(
            rootRef.current.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
        : [],
    []
  )

  // Escape closes; Tab stays inside the dialog (focus trap); focus returns to
  // the opener on close. A modal without these traps keyboard and
  // screen-reader users behind the scrim.
  React.useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    // Initial focus: first focusable child, else the dialog root.
    const f = focusables()
    ;(f[0] ?? rootRef.current)?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChangeRef.current?.(false)
        return
      }
      if (e.key !== "Tab") return
      const list = focusables()
      if (!list.length) return
      const first = list[0]!
      const last = list[list.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      restoreRef.current?.focus?.()
    }
  }, [open, focusables])

  if (!open) return null

  return (
    <div ref={rootRef} className="fixed inset-0 z-50">
      {/* backdrop; clicking it closes the modal */}
      <div
        className="fixed inset-0 bg-scrim backdrop-blur-sm animate-in fade-in-0"
        onClick={() => onOpenChange?.(false)}
      />
      {/* content container - max-h + scroll keeps tall forms usable on small screens */}
      <div className="fixed left-[50%] top-[50%] z-50 max-h-[90vh] w-full translate-x-[-50%] translate-y-[-50%] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        "mx-auto w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg",
        "animate-in fade-in-0 zoom-in-95",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
)
DialogContent.displayName = "DialogContent"

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn("flex items-center gap-2 text-lg font-semibold leading-none tracking-tight", className)} {...props} />
  )
)
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
)
DialogDescription.displayName = "DialogDescription"

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
