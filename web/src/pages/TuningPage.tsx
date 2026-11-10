// 壹座原生调优面 (add-supply-studio-migration 4.4, design D5): the tuning
// area leaves the retired /agents four-zone facade and becomes its own route.
// Behavior contracts are untouched — skill-candidate review and the persona-
// amendment placeholder are the same views the hub mounted.
//
// Doorway (restructure-yizuo-ia): the nav entry lives in the 构建 family next to
// 智能体市场 (acquire ↦ iterate). This page was URL-only between the hub's
// teardown and that change — nothing in the UI linked to it.
import { useTranslation } from "react-i18next";
import { SkillCandidatesView } from "@/components/skills/SkillCandidatesView";
import { PersonaAmendmentsView } from "@/components/persona/PersonaAmendmentsView";

export function TuningPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col bg-background" data-testid="tuning-page">
      <div className="border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold" data-testid="tuning-title">
          {t("tuning.title")}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("tuning.subtitle")}</p>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <section data-testid="tuning-skill-candidates">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("tuning.skillCandidates")}</h2>
          <SkillCandidatesView />
        </section>
        <section className="mt-8" data-testid="tuning-persona-amendments">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("tuning.personaAmendments")}</h2>
          {/* Persona revision capability未上线 — the empty-state placeholder
              (hub spec: 呈现「暂无修订」空态而非隐藏本区). */}
          <PersonaAmendmentsView />
        </section>
      </div>
    </div>
  );
}
