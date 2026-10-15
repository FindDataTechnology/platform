// Settings → Paired devices (openspec: add-device-pairing-auth). The app
// pairing surface: the mint card hands the SAME single-use 5-minute code the
// WeChat App section mints (one pool, shared lifecycle — the digits for
// typing, the QR encoding `<origin>/settings/devices?bindcode=<code>` so the
// app's scanner gets the instance address and the code in one capture), and
// below it the paired-device list with per-device revocation. A device
// credential without a kill switch should never ship, so the list is as much
// the point as the mint.
//
// Degradation mirrors WeChatAppSection: open instances have nothing to pair,
// signed-out visitors get the sign-in hint, and an older server (no
// /api/app/* routes) gets a quiet upgrade hint instead of an error.

import { useCallback, useEffect, useRef, useState } from "react";
import { MonitorSmartphone, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QrCode } from "@/components/settings/QrCode";
import { useAuthStore, withReturnTo } from "@/hooks/useAuth";

type MintState = "loading" | "ready" | "signed-out" | "unavailable" | "error";

interface PairedDevice {
  deviceId: string;
  label: string;
  boundAt: number;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DevicesSection() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore();
  const [mintState, setMintState] = useState<MintState>("loading");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState(false);
  // The deviceId whose revoke button is in its confirm step, if any.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
    };
  }, []);

  const mint = useCallback(async () => {
    setMintState("loading");
    try {
      const r = await fetch("/api/mp/bindcode", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!alive.current) return;
      if (r.status === 401) {
        setMintState("signed-out");
        return;
      }
      const contentType = r.headers.get("content-type") ?? "";
      if (r.status === 404 || !contentType.includes("application/json")) {
        setMintState("unavailable");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { code?: string; ttlMs?: number };
      if (!body.code) throw new Error("no code");
      if (!alive.current) return;
      setCode(body.code);
      setExpiresAt(Date.now() + (body.ttlMs ?? 5 * 60 * 1000));
      setNow(Date.now());
      setMintState("ready");
    } catch {
      if (alive.current) setMintState("error");
    }
  }, []);

  const loadDevices = useCallback(async () => {
    setDevicesError(false);
    try {
      const r = await fetch("/api/app/devices", { credentials: "same-origin" });
      if (!alive.current) return;
      if (r.status === 404) {
        setDevices(null); // older server: keep the list quietly absent
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDevices((await r.json()) as PairedDevice[]);
    } catch {
      if (alive.current) setDevicesError(true);
    }
  }, []);

  const openInstance = auth.mode === "none";
  useEffect(() => {
    if (openInstance || auth.loading) return;
    void mint();
    void loadDevices();
  }, [openInstance, auth.loading, mint, loadDevices]);

  useEffect(() => {
    if (mintState !== "ready") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mintState]);

  const expired = mintState === "ready" && expiresAt !== null && now >= expiresAt;
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;

  const revoke = useCallback(
    async (deviceId: string) => {
      setConfirmingId(null);
      try {
        const r = await fetch(`/api/app/bind/${encodeURIComponent(deviceId)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch {
        if (alive.current) setDevicesError(true);
      }
      await loadDevices();
    },
    [loadDevices],
  );

  return (
    <div className="flex flex-col gap-3 p-6" data-testid="settings-devices">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MonitorSmartphone className="h-4 w-4" aria-hidden="true" />
        {t("settings.devices.title")}
      </div>

      {openInstance ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.devices.openInstance")}</p>
      ) : mintState === "unavailable" ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.devices.unavailable")}</p>
      ) : mintState === "signed-out" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.devices.signedOut")}</p>
          <a
            href={withReturnTo(auth.loginUrl, window.location.href)}
            data-testid="devices-sign-in"
            className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            {t("settings.devices.signIn")}
          </a>
        </div>
      ) : mintState === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            {t("settings.devices.error")}
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
            data-testid="devices-mint-retry"
          >
            {t("settings.devices.retry")}
          </button>
        </div>
      ) : mintState === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("settings.devices.loading")}</p>
      ) : (
        <>
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.devices.scanHint")}</p>
          <div className="flex flex-wrap items-start gap-5">
            {expired ? (
              <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                {t("settings.devices.expired")}
              </div>
            ) : (
              <QrCode
                text={`${window.location.origin}/settings/devices?bindcode=${code}`}
                testId="devices-binding-qr"
              />
            )}
            <div className="flex min-w-40 flex-col items-start gap-2">
              <span
                className="select-all font-mono text-2xl font-bold tracking-[0.3em] text-foreground"
                data-testid="devices-binding-code"
              >
                {code}
              </span>
              <span className="text-xs text-muted-foreground">
                {expired
                  ? t("settings.devices.expired")
                  : t("settings.devices.expiresIn", { time: clock(secondsLeft) })}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{t("settings.devices.validity")}</span>
              <button
                type="button"
                onClick={() => void mint()}
                className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                data-testid="devices-binding-refresh"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {t("settings.devices.refresh")}
              </button>
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.devices.typeHint")}</p>
        </>
      )}

      {/* Paired devices — the revocation surface. Hidden (not empty) on an
          older server so the mint card above stays the section's truth. */}
      {devices !== null && (
        <div className="mt-2 flex flex-col gap-2" data-testid="devices-list">
          <div className="text-xs font-semibold text-foreground">{t("settings.devices.listTitle")}</div>
          {devicesError ? (
            <p className="flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {t("settings.devices.listError")}
              <button
                type="button"
                onClick={() => void loadDevices()}
                className="ml-1 inline-flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                data-testid="devices-list-retry"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {t("settings.devices.retry")}
              </button>
            </p>
          ) : devices.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground" data-testid="devices-empty">
              {t("settings.devices.empty")}
            </p>
          ) : (
            devices.map((d) => (
              <div
                key={d.deviceId}
                data-testid="device-row"
                data-device={d.deviceId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-foreground">
                    {d.label || d.deviceId}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("settings.devices.boundAt", {
                      time: new Date(d.boundAt).toLocaleString(i18n.language),
                    })}
                  </span>
                </div>
                {confirmingId === d.deviceId ? (
                  <div className="flex items-center gap-2" data-testid="device-revoke-confirming">
                    <span className="text-xs text-muted-foreground">{t("settings.devices.revokeConfirm")}</span>
                    <button
                      type="button"
                      onClick={() => void revoke(d.deviceId)}
                      className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
                      data-testid="device-revoke-confirm"
                    >
                      {t("settings.devices.revoke")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                      data-testid="device-revoke-cancel"
                    >
                      {t("settings.devices.cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(d.deviceId)}
                    className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                    data-testid="device-revoke"
                  >
                    {t("settings.devices.revoke")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
