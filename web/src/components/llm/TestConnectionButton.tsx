// TestConnectionButton — calls POST /api/llm/providers/:id/test and shows a
// spinner, then a green check + latency or a red cross + truncated error.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { testProvider, type LastTest } from "@platform/core";
import { cn } from "@/lib/utils";

interface Props {
  providerId: string;
  lastTest: LastTest | null;
}

export function TestConnectionButton({ providerId, lastTest }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LastTest | null>(lastTest);

  const onClick = async () => {
    setRunning(true);
    try {
      const r = await testProvider(providerId);
      setResult({ ok: r.ok, latencyMs: r.latencyMs, error: r.error, at: new Date().toISOString() });
    } catch (e) {
      setResult({ ok: false, latencyMs: 0, error: (e as Error).message, at: new Date().toISOString() });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={running}
        data-testid="llm-test-btn"
      >
        {running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
        {t("modelsPage.testConnection")}
      </Button>
      {result && <TestStatus result={result} />}
    </div>
  );
}

function TestStatus({ result }: { result: LastTest }) {
  const { t } = useTranslation();
  if (result.ok) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-success"
        data-testid="llm-test-ok"
      >
        <Check className="h-3.5 w-3.5" />
        {t("modelsPage.lastTest.ok")} · {result.latencyMs}ms
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs text-destructive")}
      title={result.error}
      data-testid="llm-test-failed"
    >
      <X className="h-3.5 w-3.5" />
      {t("modelsPage.lastTest.failed")}
    </span>
  );
}
