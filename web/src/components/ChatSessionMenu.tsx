// ChatSessionMenu — context menu for a single session. Two entry points, one
// component: right-click (or Shift+F10) on a sidebar row, and the chat header's
// overflow (⋯) for the active session.
//
// Contains "Clear" (clears the displayed turns) and "Delete" (with a
// confirmation dialog). Delete is disabled with a tooltip on the currently
// active session — the server also 409s it, but disabling prevents the
// obviously-wrong action. The menu dismisses on outside click, Escape, or item
// activation.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { createShare, listShares, revokeShare, type ShareInfo } from "@platform/core";
import { useChatStore } from "@platform/core";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
  isCurrent: boolean;
  onDelete: (id: string) => Promise<void>;
  // Trigger element ref so we can position the menu relative to it.
  triggerRef: React.RefObject<HTMLElement>;
  onClose: () => void;
}

export function ChatSessionMenu({ sessionId, isCurrent, onDelete, triggerRef, onClose }: Props) {
  const { t } = useTranslation();
  const clearView = useChatStore((s) => s.clearView);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Share states (openspec: add-session-share): inline create+copy feedback,
  // and a management dialog listing this user's active shares.
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [sharesOpen, setSharesOpen] = useState(false);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Position near the right edge of the row, just below it. Clamp to viewport.
    const x = Math.min(rect.left + 16, window.innerWidth - 200);
    const y = Math.min(rect.bottom + 4, window.innerHeight - 80);
    setPos({ x, y });
  }, [triggerRef]);

  useEffect(() => {
    // While the confirm dialog or the shares dialog is open, the dialog's own
    // overlay/Escape handling dismisses it — an outside click here must not
    // unmount the component out from under the dialog.
    const onDown = (e: MouseEvent) => {
      if (confirmOpen || sharesOpen) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (confirmOpen || sharesOpen) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, confirmOpen, sharesOpen]);

  if (!pos) return null;

  const handleDeleteClick = () => {
    if (isCurrent) return;
    // Do NOT call onClose() here: the parent unmounts this component on
    // close, which would destroy the confirmOpen state before the dialog
    // renders. The dropdown hides itself (confirmOpen) and onClose runs
    // when the dialog finishes (dismissed or deleted).
    setError(null);
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    setConfirmOpen(false);
    setError(null);
    onClose();
  };

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(sessionId);
      setConfirmOpen(false);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // Create a share for this session and put the public URL on the clipboard.
  const handleShare = async () => {
    setShareNote(null);
    try {
      const { token } = await createShare(sessionId);
      const url = `${window.location.origin}/share/${token}`;
      await navigator.clipboard.writeText(url);
      setShareNote(t("share.copied"));
    } catch (e) {
      setShareNote(t("share.failed", { error: (e as Error).message }));
    }
  };

  const openShares = async () => {
    setShares(null);
    setSharesOpen(true);
    try {
      setShares(await listShares());
    } catch {
      setShares([]);
    }
  };

  const handleRevoke = async (token: string) => {
    try {
      await revokeShare(token);
      setShares((s) => s?.filter((x) => x.token !== token) ?? null);
    } catch {
      // Leave the row; the dialog is a convenience view, the next open heals.
    }
  };

  return (
    <>
      {!confirmOpen && (
      <div
        ref={menuRef}
        role="menu"
        data-testid="session-menu"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          data-testid="session-menu-clear"
          onClick={() => {
            if (!isCurrent) return;
            clearView();
            onClose();
          }}
          disabled={!isCurrent}
          title={isCurrent ? undefined : t("sessionMenu.cannotClearInactive")}
          className={cn(
            "block w-full px-3 py-1.5 text-left text-xs",
            isCurrent
              ? "text-foreground hover:bg-muted"
              : "cursor-not-allowed text-muted-foreground opacity-50",
          )}
        >
          {t("sessionMenu.clear")}
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="session-menu-delete"
          onClick={handleDeleteClick}
          disabled={isCurrent}
          title={isCurrent ? t("sessionMenu.cannotDeleteActive") : undefined}
          className={cn(
            "block w-full px-3 py-1.5 text-left text-xs",
            isCurrent
              ? "cursor-not-allowed text-muted-foreground opacity-50"
              : "text-foreground hover:bg-muted",
          )}
        >
          {t("sessionMenu.delete")}
        </button>
        <div className="border-t border-border" />
        <button
          type="button"
          role="menuitem"
          data-testid="session-menu-share"
          onClick={handleShare}
          className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
        >
          {t("share.menuItem")}
        </button>
        {shareNote ? (
          <div data-testid="session-menu-share-note" className="px-3 py-1.5 text-xs text-muted-foreground">
            {shareNote}
          </div>
        ) : null}
        <button
          type="button"
          role="menuitem"
          data-testid="session-menu-manage-shares"
          onClick={() => {
            void openShares();
          }}
          className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
        >
          {t("share.manage")}
        </button>
      </div>
      )}

      <Dialog open={sharesOpen} onOpenChange={setSharesOpen}>
        <DialogContent data-testid="share-manage-dialog">
          <DialogHeader>
            <DialogTitle>{t("share.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("share.dialogHint")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto" data-testid="share-manage-list">
            {shares === null ? (
              <p className="py-3 text-xs text-muted-foreground">{t("share.loading")}</p>
            ) : shares.length === 0 ? (
              <p className="py-3 text-xs text-muted-foreground">{t("share.none")}</p>
            ) : (
              shares.map((s) => (
                <div key={s.token} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground" title={s.title}>
                    {s.title || s.sessionId}
                  </span>
                  <button
                    type="button"
                    data-testid="share-revoke-btn"
                    onClick={() => void handleRevoke(s.token)}
                    className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-destructive hover:bg-muted"
                  >
                    {t("share.revoke")}
                  </button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) closeConfirm(); }}>
        <DialogContent data-testid="session-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t("sessionMenu.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("sessionMenu.confirmBody")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p className="mt-2 text-xs text-destructive" data-testid="session-delete-error">
              {t("sessionMenu.deleteFailed", { error })}
            </p>
          )}
          <DialogFooter className="mt-4">
            <button
              type="button"
              onClick={() => { setConfirmOpen(false); setError(null); }}
              disabled={deleting}
              data-testid="session-delete-cancel"
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={deleting}
              data-testid="session-delete-confirm"
              className="rounded-md bg-destructive-deep px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive-deep/90 disabled:opacity-50"
            >
              {t("common.delete")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
