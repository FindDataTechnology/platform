// ConnectCta — the actionable "go connect" pointer (chat-connect-guidance).
//
// Rendered inside a turn's error block or a failed tool block when the server
// classified the failure as credential-shaped and named the panel whose card
// repairs it. Blocks without a pointer render nothing — this component is
// never shown on its own.
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Link2 } from "lucide-react";
import { settingsPath } from "@/components/settings/sections";

export function ConnectCta({ panel, testId }: { panel: string; testId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid={testId ?? "turn-connect-cta"}
      onClick={() => navigate(`${settingsPath("connections")}?panel=${encodeURIComponent(panel)}`)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
    >
      <Link2 className="h-3 w-3" aria-hidden="true" />
      {t("turn.connectAction")}
    </button>
  );
}
