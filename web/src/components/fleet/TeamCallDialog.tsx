// TeamCallDialog.tsx — the directory's call door (openspec:
// add-team-as-a2a-agent, 7.1).
//
// The two visibilities are two different conversations, and the dialog says so
// instead of hiding the difference behind one button:
//   • `open` — type a task, watch it stream. The quota line above the input is
//     the promise that the boundary is knowable BEFORE calling (the spec puts
//     pricing on the card for exactly this reason).
//   • `listed` — an approval gate is shown first. "Ask" is a real action that
//     queues a row in the owner's cockpit; nothing is pretended: until the
//     owner decides, the call button stays disabled and says why.
//
// Refusals are rendered from their CODE, not from the server's English message,
// so each one can tell the caller the true next step (get approved / wait for
// tomorrow / this team is paused / this deployment cannot serve calls yet).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchApprovalState,
  fetchTeamCallSurface,
  requestTeamApproval,
  streamTeamCall,
  type TeamCallSurface,
} from "@/lib/team-a2a";

export interface TeamCallTarget {
  cellId: string;
  handle: string;
  name: string;
  visibility: "listed" | "open";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TeamCallTarget | null;
}

export function TeamCallDialog({ open, onOpenChange, target }: Props) {
  const { t, i18n } = useTranslation();
  const [surface, setSurface] = useState<TeamCallSurface | null>(null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [approval, setApproval] = useState<string>("unknown");
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [answer, setAnswer] = useState("");
  const [failure, setFailure] = useState<{ code: string; detail?: Record<string, unknown> } | null>(null);
  const [asking, setAsking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    setSurfaceError(null);
    setApproval("unknown");
    try {
      const [s, state] = await Promise.all([
        fetchTeamCallSurface(target.cellId, target.handle),
        target.visibility === "listed" ? fetchApprovalState(target.cellId, target.handle) : Promise.resolve("approved"),
      ]);
      setSurface(s);
      setApproval(state);
    } catch (err) {
      setSurfaceError((err as Error).message);
    }
  }, [target]);

  useEffect(() => {
    if (!open) return;
    setText("");
    setAnswer("");
    setFailure(null);
    void load();
  }, [open, load]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const canCall = Boolean(target) && (target?.visibility === "open" || approval === "approved");

  const call = async () => {
    if (!target || !text.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setAnswer("");
    setFailure(null);
    try {
      const out = await streamTeamCall({
        cellId: target.cellId,
        handle: target.handle,
        text: text.trim(),
        signal: controller.signal,
        onDelta: (acc) => setAnswer(acc),
      });
      if (out.ok) setAnswer(out.text);
      else setFailure({ code: out.code, ...(out.detail ? { detail: out.detail } : {}) });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setFailure({ code: "internal_error" });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const ask = async () => {
    if (!target) return;
    setAsking(true);
    try {
      setApproval(await requestTeamApproval(target.cellId, target.handle));
    } catch {
      setFailure({ code: "internal_error" });
    } finally {
      setAsking(false);
    }
  };

  const quotaLine = surface
    ? t("teamCall.quota", {
        calls: surface.quota.callsPerDay,
        usedCalls: surface.usage.calls,
        usd: surface.quota.usdPerDay,
        usedUsd: surface.usage.usd.toFixed(2),
        reset: new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
          new Date(surface.resetsAt),
        ),
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto" data-testid="team-call-dialog">
        <DialogHeader>
          <DialogTitle>{t("teamCall.title", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("teamCall.subtitle")}</DialogDescription>
        </DialogHeader>

        {surfaceError ? (
          // The probe fails for more reasons than "this deployment cannot serve
          // teams": a network blip, an expired session, a 500. Claiming
          // `not_serving` for all of them tells the caller something false and
          // leaves them with nothing to do, so the CODE decides the sentence —
          // same rule the call refusals above already follow.
          <p
            className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-sm text-status-failed"
            data-testid="team-call-surface-error"
            data-error-code={surfaceError}
          >
            {t(`teamCall.errors.${surfaceError}`, { defaultValue: t("teamCall.errors.internal_error") })}
          </p>
        ) : (
          <div className="space-y-4">
            {quotaLine && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground" data-testid="team-call-quota">
                {quotaLine}
              </p>
            )}

            {target?.visibility === "listed" && approval !== "approved" && (
              <div className="rounded-md border border-status-waiting/40 bg-status-waiting/5 p-3" data-testid="team-call-approval">
                <p className="text-xs leading-5 text-foreground">{t("teamCall.needApproval")}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={asking || approval === "pending" || approval === "rejected"}
                    onClick={() => void ask()}
                    data-testid="team-call-request"
                  >
                    {asking ? t("teamCall.requesting") : t("teamCall.requestApproval")}
                  </Button>
                  <span className="text-[11px] text-muted-foreground" data-testid="team-call-approval-state">
                    {t(`teamCall.approvalState.${approval}`)}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="team-call-text">{t("teamCall.taskLabel")}</Label>
              <Textarea
                id="team-call-text"
                value={text}
                rows={3}
                maxLength={4000}
                placeholder={t("teamCall.taskPlaceholder")}
                onChange={(e) => setText(e.target.value)}
                data-testid="team-call-input"
              />
            </div>

            {failure && (
              <div className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="team-call-error">
                <div className="font-medium">{t("teamCall.errorTitle")}</div>
                <div className="mt-0.5">{t(`teamCall.errors.${failure.code}`, { defaultValue: t("teamCall.errors.internal_error") })}</div>
              </div>
            )}

            {answer && (
              <div className="rounded-md border border-border p-3" data-testid="team-call-answer">
                <div className="mb-1 text-xs font-medium text-foreground">{t("teamCall.answerTitle")}</div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{answer}</p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("teamCall.close")}
              </Button>
              <Button
                type="button"
                disabled={!canCall || streaming || !text.trim()}
                onClick={() => void call()}
                data-testid="team-call-send"
              >
                {streaming ? t("teamCall.calling") : t("teamCall.send")}
              </Button>
            </div>
            {!canCall && target?.visibility === "listed" && approval !== "approved" && (
              <p className="text-right text-[11px] text-muted-foreground">{t("teamCall.blockedUntilApproved")}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
