// AppCenterPage.tsx — the platform's discovery surface (openspec: add-app-center).
//
// Project federation, not melting: each product line keeps its own identity,
// site, and login — the center aggregates entry points only. Two sections:
//   1. The five lines (寻数五线) — brand facts single-sourced in appCatalog.ts.
//      Introductions stay on each line's own site; here it's a one-liner + link.
//   2. Platform apps — the server's external-service catalog (the same
//      /api/catalog the AgentsPage consumes). Empty or role-filtered-out →
//      the section hides entirely; a fetch error degrades the same way (the
//      five lines are static and never depend on the network).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Layers, Scale, Store, Orbit, Database, ShieldAlert } from "lucide-react";
import { APP_LINES, type AppLine } from "@/lib/appCatalog";

interface CatalogApp {
  id: string;
  kind?: string;
  name?: string;
  url?: string;
  description?: string;
  embedded?: boolean;
}

const LINE_ICONS: Record<string, typeof Layers> = {
  yizuo: Layers,
  facet: Store,
  wanxing: Orbit,
  lex: Scale,
  wire: Database,
};

function LineStatusBadge({ line }: { line: AppLine }) {
  const { t } = useTranslation();
  if (line.status === "live") return null;
  return (
    <span
      data-testid={`app-card-${line.id}-${line.status}-badge`}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {t("appCenter.status.early")}
    </span>
  );
}

function LineCard({ line }: { line: AppLine }) {
  const { t } = useTranslation();
  const Icon = LINE_ICONS[line.id] ?? Layers;
  return (
    <div
      data-testid={`app-card-${line.id}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary-deep text-primary-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <LineStatusBadge line={line} />
      </div>
      <div>
        <h3 className="font-medium">{t(line.nameKey)}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(line.taglineKey)}</p>
      </div>
      <div className="mt-auto pt-1">
        {line.self ? (
          <span
            data-testid={`app-card-${line.id}-self`}
            className="text-xs text-muted-foreground"
          >
            {t("appCenter.line.here")}
          </span>
        ) : (
          <a
            href={line.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            data-testid={`app-card-${line.id}-open`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("appCenter.open")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

export function AppCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Platform products (壹座·Packs / 萬星·词元 / 萬星·连接器 …) ride the same
  // catalog the Agents page consumes — one source of truth; product names are
  // authored in agents.json under GitOps.
  const [apps, setApps] = useState<CatalogApp[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/catalog");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c = await r.json();
      setApps((c.apps ?? []).filter((a: CatalogApp) => a.kind === "external-service" || a.kind === "link"));
    } catch {
      setApps(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="h-full overflow-y-auto bg-background" data-testid="app-center-page">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-xl font-semibold">{t("appCenter.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("appCenter.subtitle")}</p>

        <section className="mt-6" data-testid="app-center-lines">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("appCenter.linesHeading")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {APP_LINES.map((line) => (
              <LineCard key={line.id} line={line} />
            ))}
          </div>
        </section>

        {apps && apps.length > 0 && (
          <section className="mt-8" data-testid="app-center-platform-apps">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("appCenter.appsHeading")}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((app) => (
                <div
                  key={app.id}
                  data-testid={`app-card-${app.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5"
                >
                  <div>
                    <h3 className="font-medium">{app.name || app.id}</h3>
                    {app.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{app.description}</p>
                    )}
                  </div>
                  <div className="mt-auto pt-1">
                    <button
                      type="button"
                      data-testid={`app-card-${app.id}-open`}
                      onClick={() => {
                        if (app.kind === "external-service" && app.embedded !== false) navigate(`/external/${app.id}`);
                        else if (app.url) window.open(app.url, "_blank", "noreferrer");
                      }}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      {t("appCenter.open")}
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
