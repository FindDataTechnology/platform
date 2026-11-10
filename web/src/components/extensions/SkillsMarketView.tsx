// ── SkillsMarketView ────────────────────────────────────────────────────
//
// Render-only component for the skills market shelf (the skills view's 商店
// tab). Extracted from MarketTab so /extensions/skills and /extensions can
// each render this independently without showing MCP servers.
//
// Two zones (settings-connect-center): the platform catalog and the external
// market (external-skill-sources) — unreviewed third-party skill markets,
// anchored at #market-external for the retired ?tab=external deep link. The
// external zone lives here only: the tools view has no external market.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { SkillMarketCard } from "./SkillMarketCard";
import { SkillForm } from "./SkillForm";
import { ExternalSourceTab } from "./ExternalSourceTab";
import type { MarketSkill } from "@platform/core";

interface SkillsMarketViewProps {
  onInstalled?: () => void;
}

export function SkillsMarketView({ onInstalled }: SkillsMarketViewProps = {}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<MarketSkill | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  const handleInstallSkill = (skill: MarketSkill) => {
    setSelectedSkill(skill);
    setSkillFormOpen(true);
  };

  const skills = marketCatalog?.skills || [];

  return (
    <>
      <section data-testid="skills-market-section">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.skillsTitle")}</h2>
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {skills.map((skill) => (
              <SkillMarketCard key={skill.name} skill={skill} onInstall={handleInstallSkill} />
            ))}
          </div>
        )}
      </section>

      <section
        id="market-external"
        data-testid="market-external-zone"
        className="mt-8 border-t border-border pt-6"
      >
        <h2 className="text-lg font-semibold text-foreground mb-1">{t("extensions.external.zoneTitle")}</h2>
        <p className="mb-4 text-xs text-muted-foreground">{t("extensions.external.zoneSubtitle")}</p>
        <ExternalSourceTab />
      </section>

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
    </>
  );
}