// StatusSection — 设置 → 运行状态 (restructure-yizuo-ia, settings-surface).
//
// `status` (system health) and `diagnostics` (the per-turn trace list) both
// answer "what is happening right now" — they were two sibling sections, which
// made the operator scan two doors for one question. Now one section, two
// tabs: 健康 (the supervisor/resources/MCP projection) and 逐回合追踪 (the
// captured turn list).
//
// `/trace` still redirects here (the diagnostics tab); `/trace/:turnId` stays a
// top-level route because chat turn deep links land on it directly.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs } from "@/components/ui/tabs";
import { DashboardPage } from "@/pages/DashboardPage";
import { TracePage } from "@/pages/TracePage";

export type StatusTab = "health" | "trace";

const TABS: { id: StatusTab; labelKey: string; testId: string }[] = [
  { id: "health", labelKey: "settings.status.tabs.health", testId: "status-tab-health" },
  { id: "trace", labelKey: "settings.status.tabs.trace", testId: "status-tab-trace" },
];

export function StatusSection({ tab = "health" }: { tab?: StatusTab } = {}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<StatusTab>(tab);

  return (
    <div className="flex flex-col" data-testid="settings-status">
      {/* The foundation bar (unify-tab-idiom 1.2). The hand-rolled strip had
          role/aria-selected but no keyboard contract (arrows/Home/End, roving
          tabindex) and used a 2px coloured border for the active state.
          `status-tabs` / per-tab testids / `data-active` are preserved via
          itemProps because e2e asserts them. */}
      <div className="border-b border-border px-6 pt-4 pb-1" data-testid="status-tabs">
        <Tabs
          ariaLabel={t("settings.sections.status")}
          items={TABS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) }))}
          value={active}
          onChange={(id) => setActive(id as StatusTab)}
          itemProps={(id) => {
            const entry = TABS.find((x) => x.id === id);
            return {
              "data-testid": entry?.testId ?? `status-tab-${id}`,
              "data-active": active === id ? "true" : "false",
            };
          }}
        />
      </div>

      {active === "health" && (
        <div role="tabpanel" data-testid="status-panel-health">
          <DashboardPage />
        </div>
      )}
      {active === "trace" && (
        <div role="tabpanel" data-testid="status-panel-trace">
          <TracePage />
        </div>
      )}
    </div>
  );
}
