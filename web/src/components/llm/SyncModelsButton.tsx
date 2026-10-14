// SyncModelsButton — admin action that reconciles a provider's roster against
// its gateway (add-llm-model-discovery). One long-lived request (up to ~60s
// for a 33-id gateway), so the button turns into a spinner and the summary
// lands in a toast. Since add-editable-llm-route the reserved env provider
// persists its sync into the override — same flow as user providers.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/Toast";
import { syncProvider } from "@platform/core";

interface Props {
  providerId: string;
  onDone: () => void;
}

export function SyncModelsButton({ providerId, onDone }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);

  const onClick = async () => {
    setRunning(true);
    try {
      const r = await syncProvider(providerId);
      const statuses = Object.values(r.statuses);
      const serving = statuses.filter((s) => s.status === "serving").length;
      const flagged = statuses.length - serving;
      showToast(t("modelsPage.syncSummary", { added: r.added?.length ?? 0, serving, flagged }));
      onDone();
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={running}
      aria-label={t("modelsPage.syncModels")}
      data-testid="llm-sync-btn"
    >
      {running
        ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
      {t("modelsPage.syncModels")}
    </Button>
  );
}
