// MarketTab.tsx
// Tab showing the market catalog of available MCP servers and skills.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpMarketCard } from "./McpMarketCard";
import { SkillMarketCard } from "./SkillMarketCard";
import { McpServerForm } from "./McpServerForm";
import { SkillForm } from "./SkillForm";
import { Icon } from "@/components/ui/icon";
import type { MarketMcpServer, MarketSkill } from "@platform/core";

interface MarketTabProps {
  onInstalled?: () => void;
}

export function MarketTab({ onInstalled }: MarketTabProps = {}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog, installRegistrySkill } = useExtensionsStore();

  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [selectedMcp, setSelectedMcp] = useState<MarketMcpServer | null>(null);
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<MarketSkill | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [installError, setInstallError] = useState("");

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  const handleInstallMcp = (server: MarketMcpServer) => {
    setSelectedMcp(server);
    setMcpFormOpen(true);
  };

  const handleInstallSkill = async (skill: MarketSkill) => {
    setInstallError("");
    // Registry skills install server-side (content is fetched with the
    // service token); bundled skills open the pre-filled form as before.
    if (skill.origin === "registry" || !skill.skillTemplate) {
      setInstallingSkill(skill.name);
      try {
        await installRegistrySkill(skill.name);
        onInstalled?.();
      } catch (err) {
        setInstallError((err as Error).message);
      } finally {
        setInstallingSkill(null);
      }
      return;
    }
    setSelectedSkill(skill);
    setSkillFormOpen(true);
  };

  const mcpServers = marketCatalog?.mcpServers || [];
  const skills = marketCatalog?.skills || [];

  return (
    <div className="p-6 space-y-8">
      {installError && (
        <div
          className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm"
          data-testid="market-install-error"
          role="alert"
        >
          <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
          <span>{installError}</span>
        </div>
      )}

      {/* MCP Servers Section */}
      <section data-testid="mcp-market-section">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.mcpTitle")}</h2>
        {mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {mcpServers.map((server) => (
              <McpMarketCard key={server.name} server={server} onInstall={handleInstallMcp} />
            ))}
          </div>
        )}
      </section>

      {/* Skills Section */}
      <section data-testid="skills-market-section">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.skillsTitle")}</h2>
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {skills.map((skill) => (
              <SkillMarketCard
                key={skill.name}
                skill={skill}
                onInstall={handleInstallSkill}
                installing={installingSkill === skill.name}
              />
            ))}
          </div>
        )}
      </section>

      {/* Install forms - pre-filled from catalog */}
      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        setupServer={selectedMcp || null}
        onInstalled={onInstalled}
      />
      <SkillForm
        open={skillFormOpen}
        onOpenChange={setSkillFormOpen}
        initialSkill={selectedSkill?.skillTemplate ? {
          name: selectedSkill.name,
          description: selectedSkill.description,
          content: selectedSkill.skillTemplate.content,
        } : null}
        onInstalled={onInstalled}
      />
    </div>
  );
}
