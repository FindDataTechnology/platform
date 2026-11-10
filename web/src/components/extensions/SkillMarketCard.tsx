// SkillMarketCard.tsx
// Card component for displaying a market skill.

import { useTranslation } from "react-i18next";
import type { MarketSkill } from "@platform/core";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

interface SkillMarketCardProps {
  skill: MarketSkill;
  onInstall: (skill: MarketSkill) => void;
  installing?: boolean;
}

export function SkillMarketCard({ skill, onInstall, installing }: SkillMarketCardProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="skill-market-card" data-market-name={skill.name} className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {/* Supply annotation (add-skill-display-annotations): the localized
                human name replaces the raw displayName when annotated; the slug
                stays visible beside it, never replaced. */}
            <h3 className="font-medium text-foreground truncate" data-testid="skill-market-display-name">
              {skill.annotation?.name || skill.displayName}
            </h3>
            {skill.annotation?.name && skill.annotation.name !== skill.displayName && (
              <span className="font-mono text-[10px] text-muted-foreground shrink-0" data-testid="skill-market-slug">
                {skill.name}
              </span>
            )}
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {skill.category}
            </span>
            {skill.origin === "registry" && (
              <span
                data-testid="skill-registry-badge"
                className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
              >
                Registry
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2" data-testid="skill-market-summary">
            {skill.annotation?.summary || skill.description}
          </p>
        </div>
        <Button size="sm" onClick={() => onInstall(skill)} disabled={installing}>
          <Download className="h-4 w-4 mr-1" />
          {installing ? t("common.saving") : t("extensions.market.install")}
        </Button>
      </div>
    </div>
  );
}
