// ── McpInstalledView ──────────────────────────────────────────────────────
//
// Render-only component for MCP servers installed tab. Extracted from
// InstalledTab so /extensions/mcp and /extensions can each render this
// independently without showing skills.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpServerCard } from "./McpServerCard";
import { McpServerForm } from "./McpServerForm";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Plus } from "lucide-react";
import type { McpServer } from "@platform/core";

export function McpInstalledView() {
  const { t } = useTranslation();
  const mcpServers = useExtensionsStore((s) => s.mcpServers);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpServer | null>(null);
  // Per-server full-surface override (full-mode-tool-scope B3): a GLOBAL
  // preference, effective in every mode. Loaded once per mount; each toggle
  // PUTs the whole array (the route is idempotent, and the next composition
  // picks the change up).
  const [fullSurface, setFullSurface] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/mcp-tool-scope")
      .then((r) => (r.ok ? r.json() : { fullSurface: [] }))
      .then((d) => {
        if (live && Array.isArray(d?.fullSurface)) setFullSurface(d.fullSurface);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const toggleFullSurface = (name: string, on: boolean) => {
    const next = on ? [...new Set([...fullSurface, name])] : fullSurface.filter((n) => n !== name);
    setFullSurface(next);
    void fetch("/api/mcp-tool-scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullSurface: next }),
    }).catch(() => {});
  };

  const handleEditMcp = (server: McpServer) => {
    setEditingMcp(server);
    setMcpFormOpen(true);
  };

  return (
    <>
      <section data-testid="mcp-section">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">{t("extensions.mcp.title")}</h2>
          <Button size="sm" data-testid="add-mcp-btn" onClick={() => { setEditingMcp(null); setMcpFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            {t("extensions.mcp.addButton")}
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground" data-testid="mcp-full-surface-hint">
          {t("extensions.mcp.fullSurfaceHint")}
        </p>
        {mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.mcp.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {mcpServers.map((server) => (
              <div key={server.name} className="space-y-1">
                <McpServerCard server={server} onEdit={handleEditMcp} />
                <label className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                  <Switch
                    checked={fullSurface.includes(server.name)}
                    onCheckedChange={(on) => toggleFullSurface(server.name, on)}
                    data-testid={`mcp-full-surface-toggle-${server.name}`}
                  />
                  {t("extensions.mcp.fullSurface")}
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        server={editingMcp}
      />
    </>
  );
}
