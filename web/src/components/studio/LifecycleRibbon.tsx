// LifecycleRibbon — the single lifecycle action surface (add-agent-builder-
// workspace 2.1, design D3): a pure projection of the server's real state
// machine (teamRibbon), rendered as a stepper with EXACTLY one primary next
// action. The scattered save/approve/cast/trial/sign button column of the
// retired blueprint host is gone; nothing here decides a gate on its own —
// enablement comes from the projection, the server re-checks every gate.
import { useTranslation } from "react-i18next";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { RibbonAction, RibbonView } from "@/lib/workspace-lifecycle";
import { cn } from "@/lib/utils";

export function LifecycleRibbon({
  view,
  onAction,
  busy,
  trialRunning,
}: {
  view: RibbonView;
  onAction: (a: RibbonAction) => void;
  busy: boolean;
  trialRunning: boolean;
}) {
  const { t } = useTranslation();
  const label = (a: RibbonAction) =>
    a === "approve" ? t("studio.blueprint.approve")
    : a === "cast" ? t("studio.blueprint.cast")
    : a === "reseal" ? t("studio.workspace.ribbon.reseal")
    : a === "trial" ? t("studio.blueprint.trial")
    : a === "sign" ? t("studio.workspace.ribbon.sign")
    : t("studio.blueprint.unsign");

  const actionBtn = (a: { action: RibbonAction; enabled: boolean; reasonKey: string | null }, primary: boolean) => {
    const btn = (
      <Button
        size="sm"
        className="w-full"
        variant={primary ? "default" : "ghost"}
        disabled={!a.enabled || busy}
        onClick={() => onAction(a.action)}
        data-testid={`ws-ribbon-${a.action}`}
      >
        {a.action === "trial" && trialRunning ? t("studio.workspace.ribbon.trialRunning") : label(a.action)}
      </Button>
    );
    if (a.enabled || !a.reasonKey) return btn;
    return (
      <Tooltip content={t(`studio.workspace.${a.reasonKey}`)}>
        <span className="block">{btn}</span>
      </Tooltip>
    );
  };

  return (
    <div className="rounded-md border border-border p-3" data-testid="ws-ribbon">
      <div className="flex items-center gap-1">
        {view.stages.map((s, i) => (
          <div key={s.key} className="flex min-w-0 flex-1 items-center gap-1">
            <div
              data-testid={`ws-ribbon-stage-${s.key}`}
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                s.state === "current" && "bg-primary/10 font-medium text-primary",
                s.state === "done" && "text-success",
                s.state === "upcoming" && "text-muted-foreground",
              )}
            >
              {s.state === "done" ? <Check className="h-3 w-3 shrink-0" /> : s.state === "current" ? <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
              <span className="truncate">{t(`studio.workspace.ribbon.stage.${s.key}`)}</span>
            </div>
            {i < view.stages.length - 1 && <div aria-hidden className="h-px min-w-2 flex-1 bg-border" />}
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {view.next && actionBtn(view.next, true)}
        {view.secondary && actionBtn(view.secondary, false)}
        {view.noticeKey && (
          <p className="flex items-start gap-1 text-[11px] text-muted-foreground" data-testid="ws-ribbon-notice">
            {view.noticeKey === "ribbonRecastNote" && <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-status-waiting" />}
            {t(`studio.workspace.${view.noticeKey}`)}
          </p>
        )}
      </div>
    </div>
  );
}
