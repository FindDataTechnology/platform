// PairingSection — 设置 → 配对与绑定 (restructure-yizuo-ia, settings-surface).
//
// `devices` (desktop app pairing + revocable device list) and `wechat-app`
// (mini-program scan binding) were two sections minting from the SAME
// single-use 5-minute code pool. They are one concept with three tabs:
//   小程序  — the mini-program scan binding (WeChatAppSection)
//   桌面应用 — the desktop app pairing + paired-device list (DevicesSection)
//   机器    — steward machine pairing, which the machine console owns
//             (/machines); this tab is the signpost, never a second wizard.
//
// The old slugs stay addressable through `aliasProps` (sections.ts): opening
// /settings/devices or /settings/wechat-app lands here with that tab active and
// the alias slug kept in the URL, so scanned QR codes keep working — the QR
// encodes `<origin>/settings/devices?bindcode=…` and
// `<origin>/settings/wechat-app?bindcode=…`.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Server } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { WeChatAppSection } from "@/components/settings/WeChatAppSection";
import { DevicesSection } from "@/components/settings/DevicesSection";

export type PairingTab = "wechat" | "app" | "machine";

const TABS: { id: PairingTab; labelKey: string; testId: string }[] = [
  { id: "wechat", labelKey: "settings.pairing.tabs.wechat", testId: "pairing-tab-wechat" },
  { id: "app", labelKey: "settings.pairing.tabs.app", testId: "pairing-tab-app" },
  { id: "machine", labelKey: "settings.pairing.tabs.machine", testId: "pairing-tab-machine" },
];

export function PairingSection({ tab = "wechat" }: { tab?: PairingTab } = {}) {
  const { t } = useTranslation();
  // The alias slug decides the tab on open; switching tabs afterwards is local
  // state (the URL keeps the alias, which is what makes the deep link stable).
  const [active, setActive] = useState<PairingTab>(tab);

  return (
    <div className="flex flex-col" data-testid="settings-pairing">
      {/* The foundation bar (unify-tab-idiom 1.3) — same treatment as
          StatusSection: keyboard contract in, 2px border out, every testid and
          `data-active` preserved through itemProps. */}
      <div className="border-b border-border px-6 pt-4 pb-1" data-testid="pairing-tabs">
        <Tabs
          ariaLabel={t("settings.sections.pairing")}
          items={TABS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) }))}
          value={active}
          onChange={(id) => setActive(id as PairingTab)}
          itemProps={(id) => {
            const entry = TABS.find((x) => x.id === id);
            return {
              "data-testid": entry?.testId ?? `pairing-tab-${id}`,
              "data-active": active === id ? "true" : "false",
            };
          }}
        />
      </div>

      {active === "wechat" && (
        <div role="tabpanel" data-testid="pairing-panel-wechat">
          <WeChatAppSection />
        </div>
      )}
      {active === "app" && (
        <div role="tabpanel" data-testid="pairing-panel-app">
          <DevicesSection />
        </div>
      )}
      {active === "machine" && (
        <div role="tabpanel" data-testid="pairing-panel-machine" className="flex flex-col gap-3 p-6">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Server className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{t("settings.pairing.machine.body")}</p>
          </div>
          {/* One owner for the machine pairing wizard (add-machine-lifecycle-
              console): the console mints the code AND shows convergence, so a
              second wizard here would diverge from it. */}
          <Link
            to="/machines"
            data-testid="pairing-open-machines"
            className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            {t("settings.pairing.machine.open")}
          </Link>
        </div>
      )}
    </div>
  );
}
