// SkillCard.tsx
// Card component for displaying an installed skill.

import { useTranslation } from "react-i18next";
import type { Skill, CustomSkill } from "@platform/core";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2 } from "lucide-react";

interface SkillCardProps {
  skill: Skill;
  customSkill?: CustomSkill;
  onEdit?: (skill: CustomSkill) => void;
}

export function SkillCard({ skill, customSkill, onEdit }: SkillCardProps) {
  const { t } = useTranslation();
  const { toggleCustomSkill, removeCustomSkill } = useExtensionsStore();

  const isCustom = skill.source === "database";
  const canEdit = isCustom && onEdit && customSkill;

  const handleToggle = async () => {
    if (!isCustom) return; // Can't toggle file-based skills
    try {
      await toggleCustomSkill(skill.name, !skill.enabled);
    } catch (err) {
      console.error("Failed to toggle skill:", err);
    }
  };

  const handleDelete = async () => {
    if (!isCustom) return;
    if (!confirm(t("extensions.skills.confirmDelete", { name: skill.name }))) return;
    try {
      await removeCustomSkill(skill.name);
    } catch (err) {
      console.error("Failed to delete skill:", err);
    }
  };

  return (
    <div data-testid="skill-card" data-skill-name={skill.name} data-source={skill.source} className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{skill.name}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {isCustom ? t("extensions.skills.custom") : t("extensions.skills.builtIn")}
            </span>
            {!skill.enabled && isCustom && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {t("extensions.status.disabled")}
              </span>
            )}
          </div>
          {skill.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{skill.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isCustom && (
            <>
              <Switch checked={skill.enabled} onCheckedChange={handleToggle} />
              {canEdit && (
                <Button variant="ghost" size="icon" aria-label={t("common.edit")} onClick={() => onEdit(customSkill!)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label={t("common.delete")} onClick={handleDelete}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
