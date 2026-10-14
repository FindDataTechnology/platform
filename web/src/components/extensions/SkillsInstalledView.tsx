// ── SkillsInstalledView ───────────────────────────────────────────────────
//
// Render-only component for skills installed tab. Extracted from InstalledTab
// so /extensions/skills and /extensions can each render this independently
// without showing MCP servers.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { SkillCard } from "./SkillCard";
import { SkillForm } from "./SkillForm";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { CustomSkill } from "@platform/core";

export function SkillsInstalledView() {
  const { t } = useTranslation();
  const skills = useExtensionsStore((s) => s.skills);
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);

  const handleEditSkill = (skill: CustomSkill) => {
    setEditingSkill(skill);
    setSkillFormOpen(true);
  };

  // Build skill list with optional custom skill data for editing
  const skillsWithCustomData = skills.map((s) => {
    return { skill: s, customSkill: undefined as CustomSkill | undefined };
  });

  return (
    <>
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

      <SkillForm
        open={skillFormOpen}
        onOpenChange={setSkillFormOpen}
        skill={editingSkill}
      />
    </>
  );
}