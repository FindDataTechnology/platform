// InstalledTab.tsx
// Tab showing installed MCP servers and skills with add/edit/delete/toggle.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpServerCard } from "./McpServerCard";
import { SkillCard } from "./SkillCard";
import { McpServerForm } from "./McpServerForm";
import { SkillForm } from "./SkillForm";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { McpServer, CustomSkill } from "@platform/core";

export function InstalledTab() {
  const { t } = useTranslation();
  const mcpServers = useExtensionsStore((s) => s.mcpServers);
  const skills = useExtensionsStore((s) => s.skills);

  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpServer | null>(null);
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);

  const handleEditMcp = (server: McpServer) => {
    setEditingMcp(server);
    setMcpFormOpen(true);
  };

  const handleEditSkill = (skill: CustomSkill) => {
    setEditingSkill(skill);
    setSkillFormOpen(true);
  };

  // Build skill list with optional custom skill data for editing
  const skillsWithCustomData = skills.map((s) => {
    return { skill: s, customSkill: undefined as CustomSkill | undefined };
  });

  return (
    <div className="p-6 space-y-8">
      {/* MCP Section */}
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

      {/* Skills Section */}
      <section data-testid="skills-section">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">{t("extensions.skills.title")}</h2>
          <Button size="sm" data-testid="create-skill-btn" onClick={() => { setEditingSkill(null); setSkillFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            {t("extensions.skills.addButton")}
          </Button>
        </div>
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.skills.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {skillsWithCustomData.map(({ skill, customSkill }) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                customSkill={customSkill}
                onEdit={customSkill ? handleEditSkill : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {/* Forms */}
      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        server={editingMcp}
      />
      <SkillForm
        open={skillFormOpen}
        onOpenChange={setSkillFormOpen}
        skill={editingSkill}
      />
    </div>
  );
}
