// ConsolePublishBar — the owner's publication control for a team console
// (add-pack-console task 6.1: "平台侧提供公开/撤回动作").
//
// Two states only, because the model has two: unpublished (a button that
// publishes) and published (the address, a copy affordance, and a withdraw
// action). The slug is READ-ONLY here — it is server-derived so that nobody can
// squat or impersonate a team's address; the owner chooses whether to be
// reachable, not what to be called.
//
// It renders nothing on the share surface: a visitor must never see an action.
// (`surface` is passed rather than assumed so the same page component cannot be
// mounted publicly by accident.)

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import type { ConsoleSurface } from "@/components/console/console-types";

interface ConsolePublishBarProps {
  fleetId: string;
  surface: ConsoleSurface;
  published: boolean;
  slug: string | null;
  onChange: () => void;
}

export function ConsolePublishBar({ fleetId, surface, published, slug, onChange }: ConsolePublishBarProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (action: "publish" | "unpublish") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/console/${action}`, { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body?.error ?? t("console.publish.failed"));
          return;
        }
        onChange();
      } catch {
        setError(t("console.publish.failed"));
      } finally {
        setBusy(false);
      }
    },
    [fleetId, onChange, t],
  );

  // A share page has no actions at all — not even a disabled one.
  if (surface !== "platform") return null;

  const shareUrl = slug ? `${window.location.origin}/t/${encodeURIComponent(slug)}` : null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border/70 px-3 py-2" data-testid="console-publish-bar">
      <StatusPill status={published ? "running" : "neutral"} label={published ? t("console.publish.published") : t("console.publish.private")} />
      {published && shareUrl ? (
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="console-share-url">
          {shareUrl}
        </code>
      ) : (
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t("console.publish.privateHint")}</span>
      )}
      {published ? (
        <Button variant="outline" size="sm" disabled={busy} data-testid="console-unpublish" onClick={() => void act("unpublish")}>
          {t("console.publish.unpublish")}
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} data-testid="console-publish" onClick={() => void act("publish")}>
          {t("console.publish.action")}
        </Button>
      )}
      {error ? <span className="w-full text-xs text-status-failed">{error}</span> : null}
    </div>
  );
}
