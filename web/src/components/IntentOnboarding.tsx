// IntentOnboarding — the first-run questionnaire panel inside the chat welcome
// state (openspec: intent-onboarding). Renders above the suggested prompts for
// a user whose intent profile is empty and unskipped; the composer stays
// usable throughout (the panel never blocks the chat).
//
// Two phases in one panel: the questionnaire (role cards 1..3 + optional note
// + skip), then — after submitting — the confirmation list of what
// provisioning will install, with one activation. The list is the SERVER's
// plan verbatim: this component never decides what is installable.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanPack {
  // The deployment's id when the reference resolved; null when it did not
  // (absent, or invisible under admission) — then `name` carries the authored
  // reference and the row renders as unavailable.
  packId: string | null;
  ref?: string;
  name?: string;
  status: "install" | "installed" | "unavailable";
}

interface ProvisionResult {
  packId: string | null;
  ref?: string;
  name?: string;
  status: "installed" | "already-installed" | "unavailable" | "failed";
  version?: number;
  error?: string;
}

interface ProvisionResponse {
  role: string;
  results: ProvisionResult[];
  expert: { status: string; id?: string; error?: string };
  layoutPreset: string | null;
}

interface Plan {
  role: string;
  defaultExpert: string | null;
  prompts: string | null;
  layoutPreset: string | null;
  packs: PlanPack[];
  degraded: boolean;
}

interface ProfileResponse {
  profile: { roles: string[]; note: string; skipped: boolean; answeredAt: string | null; source: string };
  needsQuestionnaire: boolean;
  readyRoles: string[];
}

type Phase = "ask" | "confirm" | "done";

export function IntentOnboarding({ onProvisioned }: { onProvisioned?: () => void }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [readyRoles, setReadyRoles] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("ask");
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [expert, setExpert] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProvisionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The server decides whether the questionnaire is due for this user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/onboarding/profile");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ProfileResponse;
        if (cancelled) return;
        setReadyRoles(body.readyRoles ?? []);
        setVisible(Boolean(body.needsQuestionnaire) && (body.readyRoles ?? []).length > 0);
      } catch {
        // An unreachable server leaves the welcome state unchanged — the
        // questionnaire is an enhancement, never a blocker.
        if (!cancelled) setVisible(false);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-open (settings → 重新选择角色): re-show the panel and PRE-FILL it from
  // the stored profile. Nothing is written here — the user's next submit is
  // the write (re-answer semantics, per the capability's "change of mind").
  useEffect(() => {
    const reopen = async () => {
      try {
        const res = await fetch("/api/onboarding/profile");
        if (!res.ok) return;
        const body = (await res.json()) as ProfileResponse;
        setReadyRoles(body.readyRoles ?? []);
        setSelected(body.profile.roles ?? []);
        setNote(body.profile.note ?? "");
        setPlan(null);
        setPhase("ask");
        setVisible(true);
      } catch {
        /* an unreachable server leaves the surface as-is */
      }
    };
    window.addEventListener("onboarding:reopen", reopen);
    return () => window.removeEventListener("onboarding:reopen", reopen);
  }, []);

  const toggleRole = useCallback((role: string) => {
    setSelected((prev) => {
      if (prev.includes(role)) return prev.filter((r) => r !== role);
      if (prev.length >= 3) return prev;
      return [...prev, role];
    });
  }, []);

  const submitAnswers = useCallback(
    async (payload: { roles?: string[]; note?: string; skipped?: boolean }) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch("/api/onboarding/answers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (payload.skipped) {
          setVisible(false);
          return;
        }
        setPlan(body.plan);
        setPhase("confirm");
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const activate = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/onboarding/provision", { method: "POST" });
      const body = (await res.json().catch(() => null)) as ProvisionResponse | null;
      if (!res.ok) throw new Error((body as unknown as { error?: string })?.error || `HTTP ${res.status}`);
      // The done screen reports the SERVER's per-item outcome: claiming a
      // ready workspace while every item failed is the lie this replaces.
      setOutcome(body ?? null);
      setExpert(body?.expert?.status === "selected" ? (body.expert.id ?? null) : null);
      setPhase("done");
      onProvisioned?.();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }, [onProvisioned]);

  if (!loaded || !visible) return null;

  // Items the activation could not deliver (failed or unavailable): surfaced
  // on the done screen so "all set" never covers a partial result.
  const doneIssues = (outcome?.results ?? []).filter((r) => r.status === "failed" || r.status === "unavailable");

  return (
    <section
      className="rounded-lg border border-primary/30 bg-primary/5 p-4"
      data-testid="intent-questionnaire"
    >
      {phase === "ask" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t("onboarding.title")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("onboarding.subtitle")}</p>
          <div className="flex flex-wrap gap-2" data-testid="intent-role-cards">
            {readyRoles.map((role) => {
              const active = selected.includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => toggleRole(role)}
                  data-testid={`intent-role-${role}`}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-sm",
                    active
                      ? "border-primary bg-primary-deep text-primary-foreground"
                      : "border-border bg-background text-foreground hover:border-primary",
                  )}
                >
                  <div className="font-medium">{t(`roles.slug.${role}`)}</div>
                  <div className={cn("text-xs", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {t(`roles.note.${role}`, { defaultValue: "" })}
                  </div>
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t("onboarding.noteLabel")}</span>
            <input
              type="text"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("onboarding.notePlaceholder")}
              data-testid="intent-note"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          {error ? (
            <p className="text-sm text-destructive" data-testid="intent-error">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || !selected.length}
              onClick={() => void submitAnswers({ roles: selected, note })}
              data-testid="intent-submit"
              className="rounded-md bg-primary-deep px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("onboarding.submit")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitAnswers({ skipped: true })}
              data-testid="intent-skip"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t("onboarding.skip")}
            </button>
          </div>
        </div>
      )}

      {phase === "confirm" && plan && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            {t("onboarding.readyTitle", { role: t(`roles.slug.${plan.role}`) })}
          </h2>
          <ul className="flex flex-col gap-1.5" data-testid="intent-plan">
            {plan.packs.map((p) => (
              <li
                key={p.packId ?? p.ref ?? p.name ?? "pack"}
                className="flex items-center gap-2 text-sm text-foreground"
              >
                <Check className="h-3.5 w-3.5 text-primary" />
                {t("onboarding.planPack", { name: p.name ?? p.packId })} {p.status === "installed" ? `· ${t("onboarding.planAlready")}` : ""}
              </li>
            ))}
            {plan.defaultExpert && (
              <li className="flex items-center gap-2 text-sm text-foreground">
                <Check className="h-3.5 w-3.5 text-primary" />
                {t("onboarding.planExpert")}
              </li>
            )}
            {plan.layoutPreset && (
              <li className="flex items-center gap-2 text-sm text-foreground">
                <Check className="h-3.5 w-3.5 text-primary" />
                {t("onboarding.planLayout")}
              </li>
            )}
          </ul>
          {plan.degraded ? (
            <p className="text-xs text-muted-foreground" data-testid="intent-degraded-note">
              {t("onboarding.degradedNote")}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" data-testid="intent-error">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void activate()}
              data-testid="intent-activate"
              className="rounded-md bg-primary-deep px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("onboarding.activate")}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t("onboarding.doneTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {expert ? t("onboarding.doneExpert") : t("onboarding.doneGeneric")}
          </p>
          {/* Anything the server could not deliver is named here rather than
              swallowed by the success line above — an item that failed or is
              unavailable on this deployment must not read as "set up". */}
          {doneIssues.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="intent-outcome-issues">
              {t("onboarding.doneIssues", {
                items: doneIssues.map((r) => r.name ?? r.packId ?? r.ref ?? "").filter(Boolean).join("、"),
              })}
            </p>
          ) : null}
          {outcome?.expert?.status === "failed" ? (
            <p className="text-xs text-muted-foreground" data-testid="intent-outcome-expert">
              {t("onboarding.doneExpertUnavailable")}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setVisible(false)}
            data-testid="intent-done"
            className="self-start rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            {t("onboarding.doneClose")}
          </button>
        </div>
      )}
    </section>
  );
}
