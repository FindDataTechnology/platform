// FacadeMattersPanel — the principal's matter queue (add-matter-threads).
// Renders only when the caller's own matters exist: the server filters the
// list to the caller's own deployments, so a stranger gets an empty list and
// this panel stays hidden — matter existence is never disclosed.
//
// Each matter: the reception's escalation summary, the visitor hint, the
// timeline (open/replies/close), and the owner's two actions — reply (the
// text the reception relays verbatim on the visitor's next ask) and close
// (terminal; the reception then reports the matter closed).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as packsApi from "@/lib/packs-api";
import type { FacadeMatter } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";

const statusKey = (s: FacadeMatter["status"]) =>
  s === "open" ? "open" : s === "responded" ? "responded" : "closed";

export function FacadeMattersPanel({ packId }: { packId: string }) {
  const { t } = useTranslation();
  const [matters, setMatters] = useState<FacadeMatter[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    packsApi
      .getFacadeMatters(packId)
      .then((r) => setMatters(r.matters ?? []))
      .catch(() => setMatters([]));
  }, [packId]);
  useEffect(() => {
    load();
  }, [load]);

  if (matters === null || matters.length === 0) return null;

  const act = async (m: FacadeMatter, kind: "reply" | "close") => {
    const text = (drafts[m.id] ?? "").trim();
    if (kind === "reply" && !text) return;
    setBusy(m.id);
    setErr(null);
    try {
      const r =
        kind === "reply"
          ? await packsApi.replyFacadeMatter(packId, m.id, text)
          : await packsApi.closeFacadeMatter(packId, m.id, text || undefined);
      setMatters((prev) => (prev ?? []).map((x) => (x.id === r.matter.id ? r.matter : x)));
      setDrafts((d) => ({ ...d, [m.id]: "" }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="border border-border rounded-md p-4" data-testid="pack-facade-matters">
      <h4 className="font-medium mb-2">{t("packs.detail.facade.mattersTitle")}</h4>
      <div className="space-y-3">
        {matters.map((m) => (
          <div key={m.id} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-matter-${m.id}`}>
            <div className="flex items-center gap-2">
              <Badge>{t(`packs.detail.facade.matterStatus.${statusKey(m.status)}`)}</Badge>
              <span className="font-mono text-xs text-muted-foreground">{m.id}</span>
              <span className="text-xs text-muted-foreground">{new Date(m.updatedAt).toLocaleString()}</span>
            </div>
            <p className="text-sm" data-testid={`pack-matter-summary-${m.id}`}>
              {m.summary}
            </p>
            {m.visitorHint && (
              <p className="text-xs text-muted-foreground" data-testid={`pack-matter-visitor-${m.id}`}>
                {t("packs.detail.facade.matterVisitor", { hint: m.visitorHint })}
              </p>
            )}
            <div className="space-y-1 text-xs text-muted-foreground" data-testid={`pack-matter-timeline-${m.id}`}>
              {m.timeline.slice(-3).map((e) => (
                <p key={`${e.kind}-${e.at}`}>
                  {t(`packs.detail.facade.matterEntry.${e.kind}`)} · {e.by} · {new Date(e.at).toLocaleString()}
                  {e.text ? ` — ${e.text.slice(0, 200)}` : ""}
                </p>
              ))}
            </div>
            {m.status !== "closed" && (
              <div className="space-y-1">
                <textarea
                  className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                  rows={2}
                  maxLength={2000}
                  placeholder={t("packs.detail.facade.matterReplyPlaceholder")}
                  value={drafts[m.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                  data-testid={`pack-matter-reply-input-${m.id}`}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void act(m, "reply")}
                    disabled={busy !== null || !(drafts[m.id] ?? "").trim()}
                    data-testid={`pack-matter-reply-btn-${m.id}`}
                  >
                    {t("packs.detail.facade.matterReplyBtn")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => void act(m, "close")}
                    disabled={busy !== null}
                    data-testid={`pack-matter-close-btn-${m.id}`}
                  >
                    {t("packs.detail.facade.matterCloseBtn")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {err && <p className="mt-2 text-xs text-destructive" data-testid="pack-matters-error">{err}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{t("packs.detail.facade.mattersHint")}</p>
    </section>
  );
}
