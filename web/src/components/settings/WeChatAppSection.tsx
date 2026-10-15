// Settings → WeChat App (openspec: add-mp-scan-bind). The mini-program pairing
// surface, promoted out of the Account page and given the one thing the old
// block lacked: a QR beside the digits.
//
// Both forms carry the SAME single-use 5-minute code minted from this
// authenticated web session — the digits for typing, the QR encoding
// `<origin>/settings/wechat-app?bindcode=<code>` for the mini program's
// scanner (see the miniprogram-auth spec). One secret, two shapes: no session
// token, no new server route, nothing new to leak.
//
// The old block's degraded copy claimed a non-gateway deployment has no route.
// That is wrong — a single-process deployment serves /api/mp/bindcode too. The
// only real degraded shapes are "not signed in" (401) and "server older than
// the route" (404), and each gets its own quiet hint rather than an error.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Smartphone, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QrCode } from "@/components/settings/QrCode";
import { useAuthStore, withReturnTo } from "@/hooks/useAuth";

// "loading" and "ready" are the live path; the rest are terminal states the
// section renders as a hint. `expired` is derived from the clock, not a state.
type BindState = "loading" | "ready" | "signed-out" | "unavailable" | "error";

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

export function WeChatAppSection() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const [state, setState] = useState<BindState>("loading");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
    };
  }, []);

  const mint = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch("/api/mp/bindcode", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!alive.current) return;
      if (r.status === 401) {
        setState("signed-out");
        return;
      }
      // Any non-JSON answer is the HTML bind page (a redirect to login, or a
      // server without the route) — never an API result.
      const contentType = r.headers.get("content-type") ?? "";
      if (r.status === 404 || !contentType.includes("application/json")) {
        setState("unavailable");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { code?: string; ttlMs?: number };
      if (!body.code) throw new Error("no code");
      if (!alive.current) return;
      setCode(body.code);
      setExpiresAt(Date.now() + (body.ttlMs ?? 5 * 60 * 1000));
      setNow(Date.now());
      setState("ready");
    } catch {
      if (alive.current) setState("error");
    }
  }, []);

  // An open instance has no accounts, so there is nothing to pair and no
  // session to mint from — say so instead of offering a sign-in that cannot
  // help. Everywhere else the identity probe is the gate: it resolves before a
  // lazy section mounts, but a deep link can beat it.
  const openInstance = auth.mode === "none";
  useEffect(() => {
    if (openInstance || auth.loading) return;
    void mint();
  }, [openInstance, auth.loading, mint]);

  // The clock only drives the countdown; expiry is derived below, so there is
  // no interval-driven state transition to race the refresh.
  useEffect(() => {
    if (state !== "ready") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  const expired = state === "ready" && expiresAt !== null && now >= expiresAt;
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;

  return (
    <div className="flex flex-col gap-3 p-6" data-testid="settings-wechat-app">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        {t("settings.wechat-app.title")}
      </div>

      {openInstance ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.openInstance")}</p>
      ) : state === "unavailable" ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.unavailable")}</p>
      ) : state === "signed-out" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.signedOut")}</p>
          <a
            href={withReturnTo(auth.loginUrl, window.location.href)}
            data-testid="wechat-app-sign-in"
            className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            {t("settings.wechat-app.signIn")}
          </a>
        </div>
      ) : state === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            {t("settings.wechat-app.error")}
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
            data-testid="mp-binding-retry"
          >
            {t("settings.wechat-app.retry")}
          </button>
        </div>
      ) : state === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("settings.wechat-app.loading")}</p>
      ) : (
        <>
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.scanHint")}</p>
          <div className="flex flex-wrap items-start gap-5">
            {expired ? (
              <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                {t("settings.wechat-app.expired")}
              </div>
            ) : (
              <QrCode text={`${window.location.origin}/settings/wechat-app?bindcode=${code}`} testId="mp-binding-qr" />
            )}
            <div className="flex min-w-40 flex-col items-start gap-2">
              <span
                className="select-all font-mono text-2xl font-bold tracking-[0.3em] text-foreground"
                data-testid="mp-binding-code"
              >
                {code}
              </span>
              <span className="text-xs text-muted-foreground">
                {expired ? t("settings.wechat-app.expired") : t("settings.wechat-app.expiresIn", { time: clock(secondsLeft) })}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.validity")}</span>
              <button
                type="button"
                onClick={() => void mint()}
                className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                data-testid="mp-binding-refresh"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {t("settings.wechat-app.refresh")}
              </button>
            </div>
          </div>
          {/* The digits ARE the fallback: a phone without a working camera, or
              a scan that will not take, still pairs by typing. */}
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.wechat-app.typeHint")}</p>
        </>
      )}
    </div>
  );
}