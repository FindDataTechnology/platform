// TeamConsole — the fetching shell both hosts mount (add-pack-console).
//
// It owns three states and nothing else: loading (skeleton), unavailable
// (error with retry), and the body. The body is `ConsoleBody`, the single
// renderer implementation — the facet share page mounts THIS component with
// `surface="share"` rather than writing its own page.
//
// Why the fetch lives here instead of each page: the two hosts differ in their
// chrome (page shell vs share shell), not in their contract. Keeping one fetch
// means the query string, the 404-on-unpublished behaviour and the retry
// affordance cannot diverge.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConsoleBody } from "@/components/console/ConsoleBody";
import { SkeletonList, ErrorState, EmptyState } from "@/components/ui/states-kit";
import type { ConsoleSurface, ConsoleViewModel } from "@/components/console/console-types";

interface TeamConsoleProps {
  fleetId?: string;
  /** Share pages address a team by slug; the platform page by fleet id. */
  slug?: string;
  surface: ConsoleSurface;
  /**
   * Where to read the view model from. The platform page can leave this out
   * (same-origin `/api/fleets/...`); the facet share page MUST pass the facet's
   * own proxy path, because on the facet domain `/api/*` is the facet's API and
   * knows nothing about fleets.
   */
  endpoint?: string;
  /** Receives each successful load (publication state, headline, blocks). */
  onView?: (view: ConsoleViewModel) => void;
}

export function TeamConsole({ fleetId, slug, surface, endpoint, onView }: TeamConsoleProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<ConsoleViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ surface });
      if (slug) qs.set("slug", slug);
      const path =
        endpoint ??
        (fleetId
          ? `/api/fleets/${encodeURIComponent(fleetId)}/console`
          : `/api/fleets/by-slug/${encodeURIComponent(slug ?? "")}/console`);
      const res = await fetch(`${path}?${qs.toString()}`);
      if (res.status === 404) {
        setError("not_found");
        return;
      }
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? "forbidden" : "unavailable");
        return;
      }
      const loaded = (await res.json()) as ConsoleViewModel;
      setView(loaded);
      onView?.(loaded);
    } catch {
      // The console is an optional surface: a failed read must say so plainly
      // and leave the rest of the host (market, cockpit) untouched.
      setError("unavailable");
    } finally {
      setLoading(false);
    }
  }, [fleetId, slug, surface, endpoint, onView]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonList rows={4} />;
  if (error) {
    if (error === "forbidden") return <EmptyState title={t("console.states.forbidden")} />;
    if (error === "not_found") return <EmptyState title={t("console.states.notPublished")} />;
    return <ErrorState message={t("console.states.unavailable")} onRetry={load} retryLabel={t("common.retry")} />;
  }
  if (!view) return null;
  return <ConsoleBody view={view} />;
}
