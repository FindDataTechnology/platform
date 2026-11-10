// PluginCatalogView — the 插件 tab of the materials market
// (openspec: unify-material-market, dsh-plugin-supply MODIFIED,
// plugin-supply-request ADDED).
//
// The row set is the CATALOGUE (every plugin we curated), not the deployment's
// loaded bundles: users must be able to see what exists before it is supplied.
// Each row is in exactly one of three states, and the state decides the ONE
// action offered:
//
//   可启用 / 已启用  → the enable toggle (supplied with this deployment)
//   未供应          → 申请供应 (catalogued, not baked into this deployment)
//
// The unsupplied row deliberately does NOT render a disabled toggle: a grey
// switch says "you could click this if something were fixed on your side",
// while the true answer is "this deployment does not carry it". A dead control
// sends the user hunting for a network or permission problem that is not there.
//
// Nothing here installs anything. A request writes a row the operator's supply
// pipeline reads; supplying the plugin happens at image-build / desktop-predist
// time, and the toggle only ever flips a bundle that is already on disk.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package, RefreshCw } from "lucide-react";
import { useChatStore } from "@platform/core";
import type { PluginBundleInfo } from "@platform/core";
import { Switch } from "@/components/ui/switch";
import { wsSend } from "@/hooks/useWebSocket";
import { showToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/states-kit";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

type SupplyState = "available" | "enabled" | "unsupplied";

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Catalogue annotation, five locales; falls back to `name`/`description`. */
  human?: Record<string, { name?: string; description?: string }>;
  whenToUse?: string;
  licence?: string;
  reviewedAt?: string;
  state: SupplyState;
  requestState?: "requested" | "queued" | "supplied" | "declined" | null;
  declineReason?: string | null;
}

const STATE_LABEL: Record<SupplyState, string> = {
  available: "market.plugins.state.available",
  enabled: "market.plugins.state.enabled",
  unsupplied: "market.plugins.state.unsupplied",
};

// The status vocabulary is the platform's own (statusTokens): running = usable
// now, waiting = catalogued but not supplied, neutral = not in play.
const STATE_TONE: Record<SupplyState, "running" | "waiting" | "neutral"> = {
  available: "waiting",
  enabled: "running",
  unsupplied: "neutral",
};

export function PluginCatalogView() {
  const { t, i18n } = useTranslation();
  const bundles = useChatStore((s) => s.pluginBundles);
  const available = useChatStore((s) => s.pluginsAvailable);
  const status = useChatStore((s) => s.status);

  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The roster itself (what this deployment supplied) rides the WS, as before.
  useEffect(() => {
    if (status === "connected") wsSend({ type: "list_plugins" });
  }, [status]);

  const loadCatalog = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/plugin-catalog", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = (await r.json()) as { plugins?: CatalogEntry[] };
      setCatalog(doc.plugins ?? []);
    } catch (e) {
      setError((e as Error).message);
      setCatalog(null);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Merge: the catalogue is the row set; the WS roster decides which rows are
  // actually on disk. Client never invents a supply state.
  const rows = useMemo<CatalogEntry[]>(() => {
    if (!catalog) return [];
    const byId = new Map<string, PluginBundleInfo>(bundles.map((b) => [b.id, b]));
    return catalog.map((entry) => {
      const bundle = byId.get(entry.id);
      const state: SupplyState = bundle
        ? bundle.enabled
          ? "enabled"
          : "available"
        : "unsupplied";
      return { ...entry, state };
    });
  }, [catalog, bundles]);

  const label = useCallback(
    (entry: CatalogEntry, field: "name" | "description") => {
      const loc = entry.human?.[i18n.language] ?? entry.human?.["en"];
      return (loc?.[field] ?? entry[field]) || entry.name;
    },
    [i18n.language],
  );

  const requestSupply = async (entry: CatalogEntry) => {
    setBusy(entry.id);
    try {
      const r = await fetch("/api/plugin-supply-requests", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ pluginId: entry.id }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setCatalog((prev) =>
        prev?.map((p) => (p.id === entry.id ? { ...p, requestState: "requested" } : p)) ?? prev,
      );
      showToast({ severity: "info", title: t("market.plugins.requested", { name: label(entry, "name") }) });
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (bundle: PluginBundleInfo) => {
    wsSend({ type: "set_plugin_enabled", id: bundle.id, enabled: !bundle.enabled });
  };

  if (error) return <ErrorState message={error} onRetry={() => void loadCatalog()} retryLabel={t("common.retry")} />;
  if (!catalog) return <SkeletonList rows={3} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Package className="h-5 w-5" />}
        title={t("market.plugins.emptyTitle")}
        hint={t("market.plugins.emptyBody")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="plugin-catalog">
      {!available ? (
        <p className="text-xs text-muted-foreground" data-testid="plugin-catalog-unavailable">
          {t("market.plugins.rosterUnavailable")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((entry) => {
          const bundle = bundles.find((b) => b.id === entry.id);
          const requested = entry.requestState === "requested" || entry.requestState === "queued";
          return (
            <li
              key={entry.id}
              data-testid={`plugin-row-${entry.id}`}
              data-state={entry.state}
              className="flex items-start gap-3 rounded-lg border border-border p-3"
            >
              <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{label(entry, "name")}</span>
                  <StatusPill status={STATE_TONE[entry.state]} label={t(STATE_LABEL[entry.state])} />
                  {entry.licence ? (
                    <span className="text-[11px] text-muted-foreground/80">{entry.licence}</span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{label(entry, "description")}</p>
                {entry.whenToUse ? (
                  <p className="mt-1 text-xs text-muted-foreground/80">{entry.whenToUse}</p>
                ) : null}
                {entry.state === "unsupplied" ? (
                  <div className="mt-2">
                    {requested ? (
                      <span
                        data-testid={`plugin-request-pending-${entry.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {t("market.plugins.requestPending")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === entry.id}
                        data-testid={`plugin-request-${entry.id}`}
                        onClick={() => void requestSupply(entry)}
                        className={cn(
                          "rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground",
                          "hover:bg-accent disabled:opacity-50",
                        )}
                      >
                        {busy === entry.id ? t("common.loading") : t("market.plugins.request")}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              {entry.state !== "unsupplied" && bundle ? (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Switch
                    checked={bundle.enabled}
                    disabled={Boolean(bundle.readOnlyReason)}
                    onCheckedChange={() => toggle(bundle)}
                    aria-label={label(entry, "name")}
                    data-testid={`plugin-toggle-${entry.id}`}
                  />
                  {bundle.readOnlyReason ? (
                    <span className="max-w-[12rem] text-right text-[10px] text-muted-foreground">
                      {bundle.readOnlyReason}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => void loadCatalog()}
        data-testid="plugin-catalog-refresh"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        {t("market.plugins.refresh")}
      </button>
    </div>
  );
}
