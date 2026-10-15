// ── SkillsMarketView ────────────────────────────────────────────────────
//
// Render-only component for skills market tab. Extracted from MarketTab so
// /extensions/skills and /extensions can each render this independently
// without showing MCP servers.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { SkillMarketCard } from "./SkillMarketCard";
import { SkillForm } from "./SkillForm";
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