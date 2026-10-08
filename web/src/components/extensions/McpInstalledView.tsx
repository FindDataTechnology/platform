// ── McpInstalledView ──────────────────────────────────────────────────────
//
// Render-only component for MCP servers installed tab. Extracted from
// InstalledTab so /extensions/mcp and /extensions can each render this
// independently without showing skills.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpServerCard } from "./McpServerCard";
import { McpServerForm } from "./McpServerForm";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { McpServer } from "@platform/core";

export function McpInstalledView() {
  const { t } = useTranslation();
  const mcpServers = useExtensionsStore((s) => s.mcpServers);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpServer | null>(null);

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
        {mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.mcp.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {mcpServers.map((server) => (
              <McpServerCard key={server.name} server={server} onEdit={handleEditMcp} />
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