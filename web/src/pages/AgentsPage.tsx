// Agents & Apps catalog page. GET /api/catalog is role-filtered and
// redacted server-side; link entries open externally, nango-connect entries
// mint a connect session via the server-side broker then redirect, and
// external-service entries (NEW API) embed via /external/:appId iframe proxy.
//
// Layout: tabbed view with two sub-tabs (Agents | Apps) selected via
// ?tab=apps|agents query parameter for deep-linking. Featured items appear
// first; entries sort by id within their tier.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useChatStore } from "@platform/core";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { AgentInfo, AppInfo } from "@platform/core";

type Tab = "agents" | "apps";

export function AgentsPage() {
  const { t } = useTranslation();
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ?tab=apps|agents; default to "agents" when missing or unknown.
  const tabParam = searchParams.get("tab");
  const activeTab: Tab = tabParam === "apps" ? "apps" : "agents";

  // catalogVersion bumps on `catalog_changed` — refetch so cloud edits show up live.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/catalog");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c = await r.json();
      setAgents(c.agents ?? []);
      setApps(c.apps ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalogVersion` is the deliberate trigger — refetch when the catalog change broadcast bumps it
  useEffect(() => {
    refresh();
  }, [refresh, catalogVersion]);

  const connect = async (id: string) => {
    setConnecting(id);
    setError(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(id)}/connect`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      window.location.href = data.url as string;
    } catch (e) {
      setError((e as Error).message);
      setConnecting(null);
    }
  };

  const switchTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "apps") sp.set("tab", "apps");
    else sp.delete("tab");
    setSearchParams(sp, { replace: true });
  };

  // Sort: featured first, then alphabetical by id.
  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => {
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return a.id.localeCompare(b.id);
    }),
    [agents],
  );
  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => {
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return a.id.localeCompare(b.id);
    }),
    [apps],
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="agents-page">
      <h1 className="text-2xl font-semibold">{t("agentsPage.title")}</h1>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="agents-error">
          {t("agentsPage.loadFailed", { error })}
        </div>
      )}

      {/* Sub-tabs */}
      <div className="mt-4 border-b border-border">
        <nav className="flex gap-4" role="tablist" aria-label="Agents / Apps">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "agents"}
            data-testid="agents-tab-agents"
            onClick={() => switchTab("agents")}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === "agents"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("agentsPage.agents")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "apps"}
            data-testid="agents-tab-apps"
            onClick={() => switchTab("apps")}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === "apps"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("agentsPage.apps")}
          </button>
        </nav>
      </div>

      <div className="mt-4">
        {activeTab === "agents" && (
          <section data-testid="agents-section">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {sortedAgents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  onOpenLink={() => a.url && window.open(a.url, "_blank", "noreferrer")}
                />
              ))}
            </div>
          </section>
        )}

        {activeTab === "apps" && (
          <section data-testid="apps-section">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {sortedApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  connecting={connecting === app.id}
                  onConnect={() => connect(app.id)}
                  onOpenLink={() => app.url && window.open(app.url, "_blank", "noreferrer")}
                  onOpenEmbedded={() => navigate(`/external/${app.id}`)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// ── AgentCard ────────────────────────────────────────────────────────────

function AgentCard({ agent, onOpenLink }: { agent: AgentInfo; onOpenLink: () => void }) {
  const isExternalLink = agent.type === "agent-remote" && agent.mode === "link" && agent.url;
  // Deployed Agent Service (add-a2a-agent-serving): chat through the A2A
  // gateway from the agent picker (5.3); on this page it is informational —
  // never an openable external link.
  const isA2aService = agent.type === "agent-remote" && agent.mode === "a2a";
  return (
    <div
      className={cn(
        "rounded-lg border border-border p-4 transition-colors hover:border-primary/50",
        agent.featured && "border-primary/30 bg-primary/5",
      )}
      data-testid="agent-row"
      data-agent-id={agent.id}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-md bg-muted p-2 text-muted-foreground">
          <Icon name={agent.icon || "bot"} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{agent.name || agent.id}</h3>
            {agent.featured && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                Featured
              </span>
            )}
            {agent.version && (
              <span className="text-[10px] text-muted-foreground">v{agent.version}</span>
            )}
          </div>
          {agent.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
          )}
          {agent.tags && agent.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {agent.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            {agent.type === "agent-remote" && agent.mode === "chat" && agent.model && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-mono">
                {agent.model}
              </span>
            )}
            {isA2aService && (
              <span
                data-testid="a2a-service-badge"
                className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              >
                A2A
              </span>
            )}
            {isExternalLink && (
              <button
                onClick={onOpenLink}
                className="ml-auto text-xs text-primary hover:underline"
                data-testid="open-external-btn"
              >
                Open <Icon name="external-link" size={10} className="inline" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── AppCard ──────────────────────────────────────────────────────────────

function AppCard({
  app,
  connecting,
  onConnect,
  onOpenLink,
  onOpenEmbedded,
}: {
  app: AppInfo;
  connecting: boolean;
  onConnect: () => void;
  onOpenLink: () => void;
  onOpenEmbedded: () => void;
}) {
  const isEmbedded = app.kind === "external-service" && app.embedded !== false;
  return (
    <div
      className={cn(
        "rounded-lg border border-border p-4 transition-colors hover:border-primary/50",
        app.featured && "border-primary/30 bg-primary/5",
      )}
      data-testid="app-row"
      data-app-id={app.id}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-md bg-muted p-2 text-muted-foreground">
          <Icon name={app.icon || (app.kind === "nango-connect" ? "plug" : "app")} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{app.name || app.id}</h3>
            {app.featured && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                Featured
              </span>
            )}
            {app.version && (
              <span className="text-[10px] text-muted-foreground">v{app.version}</span>
            )}
          </div>
          {app.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{app.description}</p>
          )}
          {app.features && app.features.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {app.features.map((f) => (
                <li key={f} className="flex items-start gap-1 text-[11px] text-muted-foreground">
                  <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
          {app.tags && app.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {app.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3">
            {app.kind === "nango-connect" ? (
              <button
                onClick={onConnect}
                disabled={connecting}
                data-testid="connect-btn"
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            ) : app.kind === "external-service" ? (
              <button
                onClick={isEmbedded ? onOpenEmbedded : onOpenLink}
                data-testid="open-embedded-btn"
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
              >
                Open Dashboard
              </button>
            ) : (
              <button
                onClick={onOpenLink}
                className="text-xs text-primary hover:underline"
                data-testid="open-link-btn"
              >
                Open <Icon name="external-link" size={10} className="inline" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
