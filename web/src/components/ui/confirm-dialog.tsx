import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// ConfirmDialog — the themed replacement for native `window.confirm` (batch ③
// swaps the call sites). Reuses ui/dialog's focus trap, Escape handling and
// focus restore verbatim. Two pinned behaviors from the spec:
//   1. Cancel precedes Confirm in DOM order, so the dialog's "focus first
//      focusable" lands the keyboard on the SAFE side (spec: focus-default-safe).
//   2. The `danger` variant paints the confirm button with the destructive
//      fill; Escape (handled by Dialog) is equivalent to cancel.
// All copy arrives as props.

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  variant?: "default" | "danger"
  /** Close after confirming (default). Set false for async confirms where the
   * parent owns the lifecycle (e.g. keep the dialog open on API failure). */
  closeOnConfirm?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  variant = "default",
  closeOnConfirm = true,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* testids + data-variant live on the shared component, so the contract
          the spec states (danger variant, safe-side initial focus, Esc = cancel)
          is assertable from ONE place instead of per call site. */}
      <DialogContent className="max-w-md" data-testid="confirm-dialog" data-variant={variant}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description != null && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="confirm-dialog-cancel"
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            data-testid="confirm-dialog-confirm"
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={() => {
              onConfirm()
              if (closeOnConfirm) onOpenChange(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
