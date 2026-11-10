// 我的功集 — the facet creator console (add-facet-content-management):
// the author surface for packs published from this viewer's identity —
// list, version history, unpublish, visibility, and publish-from-manifest.
// Version history renders through the shared PackVersionList (add-facet-
// version-history) — the same presentation the public detail view uses, so
// the two surfaces cannot drift. Cell-side authoring (drafts assembled from
// installed content) stays a 壹座 surface by design; cell install stays
// refused (INSTALL_IS_A_BASE_SURFACE). All copy is keyed (five locales,
// parity enforced — polish-facet-usability replaced the bilingual inline
// precedent).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PackVersionList } from "@/components/packs/PackVersionList";

export function MineView() {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await api.listPacks({ author: "me", pageSize: 100 });
      setPacks(r.packs);
    } catch (err) {
      setPacks([]);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(t("facetMine.done", { label }));
      await refresh();
    } catch (err) {
      setNotice(t("facetMine.failed", { label, message: (err as Error).message }));
    }
  };

  if (error)
    return (
      <div className="text-sm text-destructive space-y-2" data-testid="facet-mine-error">
        <p>{t("facetMine.errorLoad", { message: error })}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!packs) return <MineSkeleton />;

  return (
    <section data-testid="facet-mine-view" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">{t("facetMine.title")}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t("facetMine.subtitle")}</p>
      </header>

      {notice && (
        <p data-testid="facet-mine-notice" className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      {packs.length === 0 && (
        <div className="text-sm text-muted-foreground space-y-1" data-testid="facet-mine-empty">
          <p>{t("facetMine.empty")}</p>
          <p className="text-xs">
            {t("facetMine.emptyGuide")}
            <a
              className="underline hover:text-foreground ml-1"
              href="https://github.com/FindDataTechnology/platform/blob/main/docs/creating-packs.md"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="facet-mine-creating-guide"
            >
              docs/creating-packs.md
            </a>
          </p>
        </div>
      )}

      <div className="grid gap-3">
        {packs.map((p) => (
          <div key={p.id} data-testid={`facet-mine-row-${p.id}`} className="border border-border rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-medium text-foreground">{p.name}</span>
              <span className="text-xs text-muted-foreground">
                v{p.version} · {p.visibility === "private" ? t("facetMine.private") : t("facetMine.public")}
                {p.unlisted ? ` · ${t("facetMine.unlisted")}` : ""}
                {p.category ? ` · ${p.category}` : ""}
              </span>
            </div>
            <p className="text-xs text-muted-foreground break-all">{p.id}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                title={p.unlisted ? t("facetMine.unpublishNote") : undefined}
                onClick={() =>
                  void act(
                    p.unlisted ? t("facetMine.unpublishNote") : t("facetMine.unpublish"),
                    () => (p.unlisted ? Promise.resolve() : api.unpublishPack(p.id)),
                  )
                }
                disabled={p.unlisted}
              >
                {t("facetMine.unpublish")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void act(t("facetMine.visibility"), () => api.setPackVisibility(p.id, p.visibility === "private" ? "public" : "private"))}
              >
                {p.visibility === "private" ? t("facetMine.makePublic") : t("facetMine.makePrivate")}
              </Button>
            </div>
            <PackVersionList packId={p.id} testId={`facet-mine-versions-${p.id}`} />
          </div>
        ))}
      </div>

      <PublishFromManifest onPublished={() => void refresh()} />
    </section>
  );
}

/** Structural skeleton matching a loaded row: title + meta + id + two controls + version strip. */
function MineSkeleton() {
  return (
    <section className="space-y-4" data-testid="facet-mine-skeleton">
      <div className="h-6 w-36 animate-pulse rounded bg-muted" />
      {[0, 1].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-44 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-3 w-64 animate-pulse rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
          </div>
          <div className="h-8 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </section>
  );
}

function PublishFromManifest({ onPublished }: { onPublished: () => void }) {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState("");
  const [packId, setPackId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        throw new Error(t("facetMine.notJson"));
      }
      const r = await api.publishPack({ packId: packId.trim() || null, manifest: parsed as never });
      setResult(t("facetMine.publishedResult", { id: r.id, version: r.version }));
      setManifest("");
      setPackId("");
      onPublished();
    } catch (err) {
      const e = err as Error & { body?: { errors?: { error: string }[] } };
      const details = e.body?.errors?.map((x) => x.error).join("；") ?? "";
      setResult(t("facetMine.publishFailed", { message: `${e.message}${details ? ` — ${details}` : ""}` }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-2" data-testid="facet-mine-publish">
      <h3 className="text-sm font-semibold">{t("facetMine.publishTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("facetMine.publishHint")}</p>
      <p className="text-xs text-muted-foreground" data-testid="facet-mine-publish-cli-hint">
        {t("facetMine.publishCliHint")}
        <code className="mx-1 px-1 rounded bg-muted font-mono">facet publish &lt;{t("facetMine.packIdWord")}&gt; --from {typeof window !== "undefined" ? window.location.origin : "<你的实例>"}</code>
      </p>
      <Input
        value={packId}
        onChange={(e) => setPackId(e.target.value)}
        placeholder={t("facetMine.publishIdPlaceholder")}
        data-testid="facet-mine-publish-id"
      />
      <textarea
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={8}
        placeholder='{ "name": "…", "skills": [...], "mcpServers": [...], "agents": [...] }'
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        data-testid="facet-mine-publish-manifest"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !manifest.trim()} onClick={() => void submit()} data-testid="facet-mine-publish-submit">
          {busy ? t("facetMine.publishing") : t("facetMine.publish")}
        </Button>
        {result && (
          <span className="text-xs text-muted-foreground break-all" data-testid="facet-mine-publish-result">
            {result}
          </span>
        )}
      </div>
    </div>
  );
}
