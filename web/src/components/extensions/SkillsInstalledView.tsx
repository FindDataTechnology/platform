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
import { SkillPackageDialog } from "./SkillPackageDialog";
import { ExternalUpdateDialog } from "./ExternalUpdateDialog";
import { Button } from "@/components/ui/button";
import { PackagePlus, Plus } from "lucide-react";
import type { CustomSkill, Skill } from "@platform/core";

export function SkillsInstalledView() {
  const { t } = useTranslation();
  const refresh = useExtensionsStore((s) => s.refreshSkills);
  const skills = useExtensionsStore((s) => s.skills);
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [packageOpen, setPackageOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);
  const [updateTarget, setUpdateTarget] = useState<Skill | null>(null);

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
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" data-testid="upload-skill-package-btn" onClick={() => setPackageOpen(true)}>
              <PackagePlus className="h-4 w-4 mr-1" />
              {t("extensions.skills.package.uploadButton")}
            </Button>
            <Button size="sm" data-testid="create-skill-btn" onClick={() => { setEditingSkill(null); setSkillFormOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" />
              {t("extensions.skills.addButton")}
            </Button>
          </div>
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
                onUpdate={setUpdateTarget}
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

      <SkillPackageDialog
        open={packageOpen}
        onOpenChange={setPackageOpen}
        onInstalled={() => void refresh()}
      />

      {updateTarget && (
        <ExternalUpdateDialog
          name={updateTarget.name}
          onOpenChange={(open) => {
            if (!open) setUpdateTarget(null);
          }}
        />
      )}
    </>
  );
}