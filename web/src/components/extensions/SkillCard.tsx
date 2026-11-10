// SkillCard.tsx
// Card component for displaying an installed skill.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { Skill, CustomSkill } from "@platform/core";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";

interface SkillCardProps {
  skill: Skill;
  customSkill?: CustomSkill;
  onEdit?: (skill: CustomSkill) => void;
  // chat-interaction-round2: explicit update entry for externally-installed
  // skills (origin_meta carries the upstream source/slug server-side).
  onUpdate?: (skill: Skill) => void;
}

export function SkillCard({ skill, customSkill, onEdit, onUpdate }: SkillCardProps) {
  const { t } = useTranslation();
  const { toggleCustomSkill, removeCustomSkill } = useExtensionsStore();

  const isCustom = skill.source === "database";
  const isExternal = (skill.originMeta as { kind?: string } | null | undefined)?.kind === "external";
  const canEdit = isCustom && onEdit && customSkill;

  const handleToggle = async () => {
    if (!isCustom) return; // Can't toggle file-based skills
    try {
      await toggleCustomSkill(skill.name, !skill.enabled);
    } catch (err) {
      console.error("Failed to toggle skill:", err);
    }
  };

  const [deleteOpen, setDeleteOpen] = useState(false);
  const handleDelete = async () => {
    if (!isCustom) return;
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
            {/* add-skill-display-annotations: the localized human label leads
                when the skill carries an annotation; the raw slug name stays
                visible in mono beside it and is never replaced. */}
            <h3 className="font-medium text-foreground truncate">
              {skill.annotation?.name || skill.name}
              {skill.annotation?.name && skill.annotation.name !== skill.name && (
                <span className="ml-1 font-mono text-[10px] text-muted-foreground" data-testid="skill-slug">{skill.name}</span>
              )}
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {isCustom ? t("extensions.skills.custom") : t("extensions.skills.builtIn")}
            </span>
            {(skill.files?.length ?? 0) > 0 && (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                data-testid="skill-file-count"
              >
                {t("extensions.skills.package.fileCountBadge", { count: skill.files!.length })}
              </span>
            )}
            {!skill.enabled && isCustom && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {t("extensions.status.disabled")}
              </span>
            )}
          </div>
          {(skill.annotation?.summary || skill.description) && (
            <p className="text-sm text-muted-foreground line-clamp-2">{skill.annotation?.summary || skill.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isCustom && (
            <>
              <Switch checked={skill.enabled} onCheckedChange={handleToggle} />
              {isExternal && onUpdate && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("extensions.external.update.button")}
                  data-testid="external-update-button"
                  onClick={() => onUpdate(skill)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              )}
              {canEdit && (
                <Button variant="ghost" size="icon" aria-label={t("common.edit")} onClick={() => onEdit(customSkill!)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label={t("common.delete")} onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("common.delete")}
        description={t("extensions.skills.confirmDelete", { name: skill.name })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
