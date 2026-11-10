// AppCenterPage.tsx — the platform's discovery surface (openspec:
// add-app-center → app-center-unified-grid; foundation kit: web-design-system,
// batch ② modernize-lagging-surfaces).
//
// Project federation, not melting: each ecosystem product keeps its own
// identity, site, and login — the center aggregates entry points only. ONE
// grid, ONE card shape (web/src/lib/appCatalog.ts owns ordering, brand
// attribution, and the connection-id map). Two data sources, both optional:
//   - Brand facts: static in appCatalog.ts — they never depend on the
//     network, so a dead backend still renders the five brand cards.
//   - Products: GET /api/catalog (role-filtered) and GET /api/connections
//     (read-only status projection, connection-center). Each fetch fails to
//     null independently: no products without a catalog, no badges or
//     connect actions without a status projection — never a broken page.
//
// Batch ② passes: the header is a PageShell (title is the first reading
// point), every card is the foundation Card, and the connection badge is the
// StatusPill vocabulary — the card states its own presence in words, so the
// state never rides on hue alone.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Layers, Scale, Store, Orbit, Database, Package, Coins, Plug, PlugZap, ShieldAlert } from "lucide-react";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useListCache } from "@/hooks/useListCache";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/ui/page-shell";
import { StatusPill } from "@/components/ui/status-pill";
import { ErrorState, Skeleton } from "@/components/ui/states-kit";
import type { StatusKind } from "@/lib/statusTokens";
import {
  APP_LINES,
  buildAppGrid,
  aggregateConnectionState,
  boardAvailable,
  boardPathFor,
  connectTargetFor,
  connectPathFor,
  type AppGridEntry,
  type CatalogApp,
} from "@/lib/appCatalog";

const BRAND_ICONS: Record<string, typeof Layers> = {
  yizuo: Layers,
  facet: Store,
  wanxing: Orbit,
  lex: Scale,
  wire: Database,
};

// Product-level icons; products fall back to their brand's icon.
const PRODUCT_ICONS: Record<string, typeof Layers> = {
  "yizuo-packs": Package,
  "wanxing-token": Coins,
  "wanxing-connector": PlugZap,
};

function iconFor(entry: AppGridEntry): typeof Layers {
  if (entry.kind === "product") {
    const product = PRODUCT_ICONS[entry.id];
    if (product) return product;
  }
  if (entry.brand) {
    const brand = BRAND_ICONS[entry.brand];
    if (brand) return brand;
  }
  return Layers;
}

// Connection state → the four-word status vocabulary. The label always rides
// along (appCenter.connection.*), so the pill is readable without color.
const CONNECTION_STATUS: Record<string, StatusKind> = {
  connected: "running",
  partial: "waiting",
  stale: "waiting",
  disconnected: "paused",
};

function AppCard({ entry, states }: { entry: AppGridEntry; states: Record<string, string> | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lineBoardsEnabled } = useAppConfig();
  const Icon = iconFor(entry);

  // Nango products (simplify-chat-and-agents-ia, from the retired Agents-page
  // Apps tab): the primary action mints a connect session through the
  // platform's broker and redirects to the Connect UI; a failure stays on the
  // card, named — never a silent dead click.
  const isNango = entry.kind === "product" && entry.catalogKind === "nango-connect";
  const [nangoBusy, setNangoBusy] = useState(false);
  const [nangoError, setNangoError] = useState<string | null>(null);
  const nangoConnect = async () => {
    setNangoBusy(true);
    setNangoError(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(entry.id)}/connect`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      window.location.href = data.url as string;
    } catch (e) {
      setNangoError((e as Error).message);
      setNangoBusy(false);
    }
  };

  const state = states ? aggregateConnectionState(entry.connections, states) : null;
  const target = states ? connectTargetFor(entry.connections, states) : null;

  // Board as primary action (app-center spec, add-wire-line-board D7): the
  // deployment switch is on AND the board's OWN credential is connected —
  // not the card's aggregate badge, which may fold in unrelated connections
  // (wire's paper-trading). With a board, "打开原站" stays as the secondary.
  const canShowBoard = boardAvailable(entry.id, states, lineBoardsEnabled);
  const boardPath = boardPathFor(entry.id);

  return (
    <Card data-testid={`app-card-${entry.id}`} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        {/* Brand/product icon tile: a neutral identity marker, NOT an accent —
            the lamp stays on actions and live signals only (one-lamp rule). */}
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex items-center gap-1.5">
          {state && (
            <StatusPill
              data-testid={`app-card-${entry.id}-connection-badge`}
              data-state={state}
              status={CONNECTION_STATUS[state] ?? "neutral"}
              label={t(`appCenter.connection.${state}`)}
            />
          )}
          {entry.status === "early" && (
            <span
              data-testid={`app-card-${entry.id}-early-badge`}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              {t("appCenter.status.early")}
            </span>
          )}
        </div>
      </div>
      <div>
        <h3 className="font-medium">
          {entry.kind === "brand" ? t(entry.nameKey) : entry.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {entry.kind === "brand" ? t(entry.taglineKey) : entry.description ?? ""}
        </p>
      </div>
      <div className="mt-auto flex items-center gap-4 pt-1">
        {isNango ? (
          <span className="flex flex-col items-start gap-1">
            <button
              type="button"
              data-testid={`app-card-${entry.id}-nango-connect`}
              disabled={nangoBusy}
              onClick={() => void nangoConnect()}
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
            >
              {nangoBusy ? t("appCenter.nangoConnecting") : t("appCenter.nangoConnect")}
              <Plug className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {nangoError && (
              <span data-testid={`app-card-${entry.id}-nango-error`} className="text-xs text-status-failed">
                {nangoError}
              </span>
            )}
          </span>
        ) : entry.self ? (
          <span data-testid={`app-card-${entry.id}-self`} className="text-xs text-muted-foreground">
            {t("appCenter.here")}
          </span>
        ) : entry.embedded ? (
          // external-service with embedding allowed: the in-app proxy route
          // (app-center spec「直达外链与内嵌页」; restored after it was dropped
          // alongside the board CTA in the sister change).
          <button
            type="button"
            data-testid={`app-card-${entry.id}-open`}
            onClick={() => navigate(`/external/${entry.id}`)}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("appCenter.open")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <>
            {/* Primary action: 看板 when the board is available, else 打开 */}
            {canShowBoard ? (
              <>
                <button
                  type="button"
                  data-testid={`app-card-${entry.id}-board`}
                  onClick={() => navigate(boardPath)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t("appCenter.board")}
                </button>
                <a
                  href={entry.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`app-card-${entry.id}-open`}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("appCenter.openOrigin")}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </>
            ) : (
              <a
                href={entry.url ?? "#"}
                target="_blank"
                rel="noreferrer"
                data-testid={`app-card-${entry.id}-open`}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {t("appCenter.open")}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </>
        )}
        {state && state !== "connected" && target && (
          <button
            type="button"
            data-testid={`app-card-${entry.id}-connect`}
            onClick={() => navigate(connectPathFor(target))}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <Plug className="h-3.5 w-3.5" aria-hidden="true" />
            {t("appCenter.connection.connect")}
          </button>
        )}
      </div>
    </Card>
  );
}

// Module-level fetchers: stable identities for useListCache.
async function fetchCatalog(): Promise<{ apps?: CatalogApp[] }> {
  const r = await fetch("/api/catalog");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchConnectionStates(): Promise<Record<string, string>> {
  const r = await fetch("/api/connections");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const c = await r.json();
  const byId: Record<string, string> = {};
  for (const item of c.connections ?? []) byId[item.id] = item.state;
  return byId;
}

export function AppCenterPage() {
  const { t } = useTranslation();
  // Two independent cached reads (openspec: polish-web-surfaces,
  // web-list-surfaces): a dead /api/catalog keeps the brand cards, a dead
  // /api/connections keeps the cards — neither blocks the other. Both are
  // seeded from cache, so a revisit paints the full grid instead of flashing
  // the five static brand cards and then growing into the products.
  // The catalog read opts into one automatic backoff retry (openspec:
  // app-center-load-recovery D2): a transient first-pull failure heals
  // without user intervention; only the exhausted attempt shows the error
  // state. connections keeps the silent posture by design.
  const catalog = useListCache("catalog", fetchCatalog, { coldRetry: 1 });
  const connections = useListCache("connections", fetchConnectionStates);
  const apps = catalog.data?.apps ?? null;
  const states = connections.data;
  const grid = useMemo(() => buildAppGrid(APP_LINES, apps), [apps]);
  // Cold load (no cache yet): the product slots are unknown, so placeholder
  // tiles stand in — the grid never reads as "complete at five" and then grows.
  const showProductSkeleton = catalog.status === "loading" && apps === null;
  // Cold failure (nothing cached, automatic retry spent): the brand cards
  // stay — the never-a-broken-page doctrine holds — but the product area
  // names the failure and offers the way out instead of a silent half-grid
  // (openspec: app-center-load-recovery).
  const coldFailure = catalog.status === "error" && catalog.data === null;

  return (
    <PageShell data-testid="app-center-page" title={t("appCenter.title")} subtitle={t("appCenter.subtitle")}>
      <div className="mx-auto max-w-4xl">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="app-center-grid">
          {grid.map((entry) => (
            <AppCard key={entry.id} entry={entry} states={states} />
          ))}
          {showProductSkeleton &&
            [0, 1, 2].map((i) => (
              <Skeleton key={`app-card-skeleton-${i}`} data-testid="app-card-skeleton" className="h-[152px]" />
            ))}
        </div>
        {coldFailure && (
          <div data-testid="app-center-load-error" className="mt-4">
            <ErrorState
              message={t("appCenter.loadError")}
              onRetry={() => void catalog.refresh()}
              retryLabel={t("common.retry")}
            />
          </div>
        )}
      </div>
    </PageShell>
  );
}
