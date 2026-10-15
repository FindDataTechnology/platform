// System Status (Settings → System Status, route `/settings/status`): read-only
// system health view. Fetches /api/supervisor/status (non-secret fields only).
// Sections: Health, Active Configuration, Resources, MCP.
//
// Each row links to the surface that controls it, and there are two kinds.
// Models and MCP are Settings sections, so their links switch panes inside the
// open modal — and must carry `location.state` forward, or the modal forgets
// what it was covering and closing drops the user on /chat. Agents is a work
// surface, so its link leaves /settings and the modal unmounts. That asymmetry
// is intentional, not an oversight.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { settingsPath } from "@/components/settings/sections";
import { cn } from "@/lib/utils";

interface ServerRow {
  id: string;
  name: string;
  kind: string;
  state: string;
  pid?: number;
  port?: number;
  url?: string | null;
}
interface Status {
  servers: ServerRow[];
  provider: string | null;
  currentModel: string | null;
  currentAgent?: string | null;
  documentCount: number;
  documentByStatus?: Record<string, number>;
  collectionCount: number;
  mcpToolCount: number;
  uptimeMs?: number;
}

const STATE_COLORS: Record<string, string> = {
  healthy: "text-success",
  disabled: "text-muted-foreground",
  unhealthy: "text-destructive",
  starting: "text-warning",
};

const STATE_DOT: Record<string, string> = {
  healthy: "bg-success",
  disabled: "bg-muted-foreground",
  unhealthy: "bg-destructive",
  starting: "bg-warning",
};

export function DashboardPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/supervisor/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="system-status-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="system-status-title">
          {t("systemStatus.title")}
        </h1>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          data-testid="system-status-refresh"
        >
          {loading ? t("systemStatus.refreshing") : t("systemStatus.refresh")}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="system-status-error">
          {t("systemStatus.loadFailed", { error })}
          <button onClick={refresh} className="ml-2 underline">{t("systemStatus.retry")}</button>
        </div>
      )}

      {status && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {/* Health */}
          <section className="rounded-md border border-border p-4" data-testid="health-section">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("systemStatus.health")}</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {status.servers.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 text-sm"
                  data-testid="server-row"
                  data-server-id={s.id}
                >
                  <span className={cn("h-2 w-2 rounded-full", STATE_DOT[s.state] ?? "bg-muted-foreground")} />
                  <span className="font-medium">{s.name}</span>
                  <span className={cn("text-xs", STATE_COLORS[s.state] ?? "text-muted-foreground")} data-testid="server-state">
                    {t(`systemStatus.state.${s.state}`, { defaultValue: s.state })}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.kind}{s.port ? ` :${s.port}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Active Configuration */}
          <section className="rounded-md border border-border p-4" data-testid="active-config-section">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("systemStatus.activeConfig")}</h2>
            <dl className="mt-2 flex flex-col gap-1.5 text-sm">
              <ConfigRow
                label={t("systemStatus.provider", { name: status.provider ?? "—" })}
                value={status.currentModel ?? "—"}
                to={settingsPath("models")}
                state={location.state}
                manageLabel={t("systemStatus.manage")}
              />
              <ConfigRow
                label={t("systemStatus.activeAgent")}
                value={status.currentAgent ?? "—"}
                to="/agents"
                manageLabel={t("systemStatus.manage")}
              />
            </dl>
            {typeof status.uptimeMs === "number" && (
              <p className="mt-3 text-xs text-muted-foreground">{t("systemStatus.uptime", { sec: Math.round(status.uptimeMs / 1000) })}</p>
            )}
          </section>

          {/* Resources */}
          <section className="rounded-md border border-border p-4" data-testid="resources-section">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("systemStatus.resources")}</h2>
            <div className="mt-2 flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <span>{t("systemStatus.documents")}</span>
                <span className="text-xl font-semibold" data-testid="doc-count">{status.documentCount}</span>
                {status.documentByStatus && (
                  <span className="text-xs text-muted-foreground">
                    {Object.entries(status.documentByStatus)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ") || t("systemStatus.none")}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t("systemStatus.collections", { count: status.collectionCount })}</p>
            </div>
          </section>

          {/* MCP */}
          <section className="rounded-md border border-border p-4" data-testid="mcp-section">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("systemStatus.mcpTools")}</h2>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-2xl font-semibold" data-testid="mcp-count">{status.mcpToolCount}</span>
              <Link
                to={settingsPath("mcp")}
                state={location.state}
                className="text-xs text-primary hover:underline"
                data-testid="mcp-manage-link"
              >
                {t("systemStatus.manage")} →
              </Link>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function ConfigRow({
  label,
  value,
  to,
  state,
  manageLabel,
}: {
  label: string;
  value: string;
  to: string;
  // Carried only by links that stay inside the Settings modal.
  state?: unknown;
  manageLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm" data-testid="config-row-value">{value}</dd>
      <Link
        to={to}
        state={state}
        className="text-xs text-primary hover:underline"
        data-testid="config-row-manage"
      >
        {manageLabel} →
      </Link>
    </div>
  );
}
