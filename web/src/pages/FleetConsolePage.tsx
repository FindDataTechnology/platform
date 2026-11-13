// FleetConsolePage — the team's own console inside 壹座 (add-pack-console).
//
// Distinct from the cockpit (`/fleets/:fleetId`): the cockpit is the OWNER's
// canvas with management actions; this page is the team's face — the blocks the
// pack declared, in the pack's own order, read-only. The same `TeamConsole`
// component mounts on the facet share page with `surface="share"`, which is what
// makes "one implementation, two hosts" true rather than aspirational.
//
// The publication bar is the owner's only write action here: it decides whether
// the console is reachable publicly, never what its address is (the slug is
// server-derived). A reload is a remount via `reloadKey` — the view model is
// derived per request, so there is nothing to patch client-side.
//
// Route: /fleets/:fleetId/console

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/states-kit";
import { TeamConsole } from "@/components/console/TeamConsole";
import { ConsolePublishBar } from "@/components/console/ConsolePublishBar";
import type { ConsoleViewModel } from "@/components/console/console-types";

export function FleetConsolePage() {
  const { t } = useTranslation();
  const { fleetId } = useParams<{ fleetId: string }>();
  const [view, setView] = useState<ConsoleViewModel | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const onView = useCallback((loaded: ConsoleViewModel) => setView(loaded), []);
  const reload = useCallback(() => {
    setView(null);
    setReloadKey((n) => n + 1);
  }, []);

  return (
    <PageShell
      title={t("console.title")}
      titleTestId="fleet-console-title"
      subtitle={t("console.page.subtitle")}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 md:px-6" data-testid="fleet-console-page">
        {fleetId ? (
          <>
            <ConsolePublishBar
              fleetId={fleetId}
              surface="platform"
              published={view?.fleet?.published === true}
              slug={view?.fleet?.slug ?? null}
              onChange={reload}
            />
            <TeamConsole key={reloadKey} fleetId={fleetId} surface="platform" onView={onView} />
          </>
        ) : (
          <EmptyState title={t("console.states.notPublished")} />
        )}
      </div>
    </PageShell>
  );
}
