// FirstResultGuidance — the first-run `provisioned` surface
// (openspec: first-run-onboarding / onboarding-guidance). Replaces the old
// three-step navigation coach-mark tour: instead of pointing at buttons, it
// leads the newcomer to ONE concrete result — install the preferred official
// starter team and land where it shows up.
//
// Not a full-screen modal: it is an inline card over the welcome surface, so the
// composer and prompts stay usable (spec: must not block beyond the card).
// `mode` distinguishes the provisioning surface (finish advances the stage to
// `done`) from the help-center replay (finish only closes; stage unchanged).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check, Loader2, Users, X } from "lucide-react";
import { STARTER_TEAMS } from "@/lib/packGuides";
import { IS_DESKTOP } from "@/lib/environment";
import { installPack, subscribePack } from "@/lib/packs-api";

const PREFERRED = STARTER_TEAMS.find((t) => t.role === "preferred") ?? STARTER_TEAMS[0];

type InstallState = "idle" | "working" | "confirm" | "done" | "failed";

interface Props {
  mode: "provisioned" | "replay";
  onDone: () => void;
}

export function FirstResultGuidance({ mode, onDone }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<InstallState>("idle");
  // Desktop-only: whether the local-cluster step applies (desktop shell, a
  // preset exists, and no cluster yet). Same predicate the old tour used.
  const [fleet, setFleet] = useState(false);
  const [fleetState, setFleetState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [fleetFile, setFleetFile] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDone]);

  useEffect(() => {
    if (!IS_DESKTOP || mode === "replay") return;
    let cancelled = false;
    (async () => {
      try {
        const presets = await fetch("/api/wanxing/fleet/presets")
          .then((r) => (r.ok ? r.json() : { bundles: [] }))
          .catch(() => ({ bundles: [] }));
        const first = Array.isArray(presets?.bundles) ? presets.bundles[0] : null;
        if (!first) return;
        const dep = await fetch("/api/wanxing/fleet/deployments")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const empty = !dep || (dep.deployments ?? []).length === 0;
        if (!cancelled && empty) {
          setFleet(true);
          setFleetFile(first.file ?? null);
        }
      } catch {
        /* offline / not enabled: skip the fleet step */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const install = useCallback(
    async (confirm = false) => {
      if (!PREFERRED) return;
      setState("working");
      try {
        const sub = await subscribePack(PREFERRED.packId);
        await installPack(sub.packId, sub.version, confirm);
        setState("done");
      } catch (e) {
        const code = (e as { body?: { code?: string } })?.body?.code;
        setState(code === "script-confirm-required" ? "confirm" : "failed");
      }
    },
    [],
  );

  const installFleet = useCallback(async () => {
    if (!fleetFile) return;
    setFleetState("working");
    try {
      const res = await fetch("/api/wanxing/fleet/presets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: fleetFile }),
      });
      setFleetState(res.ok ? "done" : "failed");
    } catch {
      setFleetState("failed");
    }
  }, [fleetFile]);

  const primaryLabel =
    state === "working"
      ? t("onboarding.guidance.installing")
      : state === "confirm"
        ? t("onboarding.guidance.confirm")
        : state === "done"
          ? t("onboarding.guidance.finish")
          : t("onboarding.guidance.install");

  const onPrimary = () => {
    if (state === "idle") void install(false);
    else if (state === "confirm") void install(true);
    else if (state === "done") {
      onDone();
      navigate("/chat");
    }
  };

  return (
    <section
      data-testid="first-result-guidance"
      data-mode={mode}
      className="rounded-lg border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{t("onboarding.guidance.title")}</h2>
        </div>
        <button
          type="button"
          onClick={onDone}
          aria-label={t("onboarding.skip")}
          title={t("onboarding.skip")}
          data-testid="guidance-skip"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        {t("onboarding.guidance.body", { team: PREFERRED?.name ?? "" })}
      </p>

      {PREFERRED ? (
        <div className="mt-2 rounded-md border border-border bg-background p-2">
          <p className="text-sm font-medium text-foreground">{PREFERRED.name}</p>
          <p className="text-xs text-muted-foreground">{PREFERRED.oneLine}</p>
        </div>
      ) : null}

      {state === "failed" ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="guidance-unavailable">
          {t("onboarding.guidance.unavailable")}
        </p>
      ) : null}
      {state === "done" ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground" data-testid="guidance-result">
          <Check className="h-3.5 w-3.5 text-primary" />
          {t("onboarding.guidance.result")}
        </p>
      ) : null}

      {/* Desktop-only local-cluster step, appended after the starter result. */}
      {fleet ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-sm font-medium text-foreground">{t("onboarding.guidance.fleetTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("onboarding.guidance.fleetBody")}</p>
          <button
            type="button"
            disabled={fleetState === "working"}
            onClick={() => void installFleet()}
            data-testid="guidance-fleet-install"
            className="mt-2 rounded-md border border-primary/40 px-3 py-1 text-xs text-foreground hover:border-primary disabled:opacity-60"
          >
            {fleetState === "working"
              ? t("onboarding.guidance.installing")
              : fleetState === "done"
                ? t("onboarding.guidance.fleetInstalled")
                : t("onboarding.guidance.fleetInstall")}
          </button>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={state === "working"}
          onClick={onPrimary}
          data-testid="guidance-install"
          className="rounded-md bg-primary-deep px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {state === "working" ? <Loader2 className="h-4 w-4 animate-spin" /> : primaryLabel}
        </button>
        {state !== "done" ? (
          <button
            type="button"
            onClick={onDone}
            data-testid="guidance-dismiss"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("onboarding.skip")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
