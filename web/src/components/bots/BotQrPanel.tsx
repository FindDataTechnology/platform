// BotQrPanel — the "扫码配置 / 用户入口" section of a saved bot's dialog.
//
// Pure presentation over the GET /api/bots/:id/qr states (design D4): resolving
// spinner, resolved SVG + link + per-platform steps, or the manual-link
// fallback. All states share one reserved min-height so switching never shifts
// the dialog layout. The server renders the QR SVG — the browser never sees a
// credential and needs no QR library.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showToast } from "@/components/Toast";
import { getBotQr, updateBot, type Bot, type BotQr } from "@platform/core";

const dataUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

export function BotQrPanel({ bot, onSaved }: { bot: Bot; onSaved: () => void }) {
  const { t } = useTranslation();
  const [qr, setQr] = useState<BotQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [link, setLink] = useState("");

  // A fetch failure lands in the same fallback shape as an upstream rejection,
  // so a transient network error degrades to the manual prompt, not a crash.
  const loadQr = useCallback(async () => {
    setLoading(true);
    try {
      setQr(await getBotQr(bot.id));
    } catch (e) {
      setQr({ strategy: "manual", url: null, qr: null, hint: "botsPage.qr.hint.manual", error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void loadQr();
  }, [loadQr]);

  const saveLink = async () => {
    try {
      await updateBot(bot.id, { credentials: { qrUrl: link } });
      showToast(t("botsPage.saved"));
      onSaved();
      await loadQr();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const copyLink = async () => {
    if (!qr?.url) return;
    try {
      await navigator.clipboard.writeText(qr.url);
      showToast(t("botsPage.qr.linkCopied"));
    } catch {
      showToast(t("botsPage.copyFailed"));
    }
  };

  return (
    <div data-testid="bot-qr-panel" className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="text-sm font-medium text-foreground">{t("botsPage.qr.title")}</div>
      {!bot.enabled && (
        <p className="text-xs text-muted-foreground" data-testid="bot-qr-disabled">
          {t("botsPage.qr.disabledNote")}
        </p>
      )}

      <div className="flex min-h-44 items-center justify-center">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="bot-qr-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("botsPage.qr.resolving")}
          </div>
        ) : qr?.url && qr.qr ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <img
              src={dataUri(qr.qr)}
              alt={t("botsPage.qr.title")}
              data-testid="bot-qr-img"
              className="h-40 w-40 rounded-md bg-white p-1"
            />
            <div className="flex min-w-0 flex-col gap-2">
              <code
                data-testid="bot-qr-url"
                className="max-w-56 truncate rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
              >
                {qr.url}
              </code>
              <Button variant="outline" size="sm" onClick={copyLink} data-testid="bot-qr-copy">
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t("botsPage.qr.copyLink")}
              </Button>
              <p className="text-xs text-muted-foreground">{t(qr.hint)}</p>
            </div>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-2">
            {qr?.error && (
              <p data-testid="bot-qr-error" className="text-xs text-destructive">
                {t("botsPage.qr.resolveFailed")} {qr.error}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("botsPage.qr.manualPrompt")}</p>
            <div className="flex items-center gap-2">
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={t("botsPage.qr.manualPlaceholder")}
                data-testid="bot-qr-manual-input"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={saveLink}
                disabled={!link.trim()}
                data-testid="bot-qr-manual-save"
              >
                {t("botsPage.qr.saveLink")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
