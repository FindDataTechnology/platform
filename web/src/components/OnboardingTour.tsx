// OnboardingTour — the three-step first-run tour over the chat welcome state
// (add-onboarding-tutorial): ① pick an expert (the agent picker), ② state the
// request (the suggested-prompt cards), ③ collect the outputs (the Outputs
// nav entry). A coach-mark card anchors to each step's real surface with a
// highlight ring — deliberately NOT a full-screen dimmed backdrop, so the
// underlying surface stays usable and the modal/keyboard stack (whose Escape
// and focus handling we just finished reconciling in simplify-ia-non-technical)
// is never fighting a second overlay layer.
//
// Persistence is one localStorage key; skipping and finishing both write it.
// Escape dismisses. Replay (help center) clears the key and re-mounts this
// component via the `onboarding:replay` window event.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const TOUR_DONE_KEY = "onboarding.tour.done";

export function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourDone(): void {
  try {
    localStorage.setItem(TOUR_DONE_KEY, "1");
  } catch {
    // Private-mode quota errors are non-fatal: the tour just shows again.
  }
}

export function clearTourDone(): void {
  try {
    localStorage.removeItem(TOUR_DONE_KEY);
  } catch {
    // ignore
  }
}

/** Help center replay: clears the marker and asks ChatPage to re-mount the tour. */
export function replayTour(): void {
  clearTourDone();
  window.dispatchEvent(new Event("onboarding:replay"));
}

// The anchored surfaces, in walk order. Each entry: the data-testid to anchor
// to and whether the card sits above or below the anchor by default. The
// composer exists on the welcome state too (ChatWelcome renders above it).
const STEPS: { anchor: string; placement: "top" | "bottom" | "right" }[] = [
  { anchor: "agent-preset-picker", placement: "bottom" },
  { anchor: "composer-input", placement: "top" },
  { anchor: "nav-resources", placement: "right" },
];

const CARD_WIDTH = 300;
const EDGE = 12;

export function OnboardingTour({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Locate the current anchor. On narrow screens (no md rail) the sidebar is
  // off-canvas — the card degrades to a centered card without a ring.
  const locate = useCallback(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-testid="${STEPS[step]!.anchor}"]`);
    if (!anchor) {
      setRect(null);
      return;
    }
    const r = anchor.getBoundingClientRect();
    // Off-viewport anchors (the collapsed rail's nav) fall back to centering.
    setRect(r.width > 0 && r.bottom > 0 && r.top < window.innerHeight ? r : null);
  }, [step]);

  useEffect(() => {
    locate();
    // Re-measure on resize/scroll so the ring follows.
    window.addEventListener("resize", locate);
    window.addEventListener("scroll", locate, true);
    return () => {
      window.removeEventListener("resize", locate);
      window.removeEventListener("scroll", locate, true);
    };
  }, [locate]);

  const finish = useCallback(() => {
    markTourDone();
    onFinish();
  }, [onFinish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish();
      } else if (e.key === "Enter") {
        setStep((s) => (s < STEPS.length - 1 ? s + 1 : s));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [finish]);

  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : finish());
  const anchored = rect !== null;

  // Card position: anchored above/below/beside the ring, clamped to the
  // viewport; centered when no anchor.
  const cardStyle = (() => {
    if (!anchored || !rect) {
      return { left: "50%", top: "38%", transform: "translate(-50%, 0)" };
    }
    const placement = STEPS[step]!.placement;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let left: number;
    let top: number;
    if (placement === "bottom") {
      left = rect.left + rect.width / 2 - CARD_WIDTH / 2;
      top = rect.bottom + EDGE;
    } else if (placement === "top") {
      left = rect.left + rect.width / 2 - CARD_WIDTH / 2;
      const cardTop = rect.top - EDGE - 150;
      top = cardTop > EDGE ? cardTop : rect.bottom + EDGE;
    } else {
      const railHidden = rect.right <= 0 || rect.left >= vw;
      left = railHidden ? vw / 2 - CARD_WIDTH / 2 : rect.right + EDGE;
      top = rect.top;
    }
    left = Math.min(Math.max(EDGE, left), vw - CARD_WIDTH - EDGE);
    top = Math.min(Math.max(EDGE, top), vh - 190);
    return { left, top };
  })();

  const n = step + 1;

  return (
    <div data-testid="onboarding-tour">
      {/* Highlight ring over the anchored surface (anchored steps only). */}
      {rect && (
        <div
          aria-hidden="true"
          data-testid="tour-ring"
          className="pointer-events-none fixed z-40 rounded-lg border-2 border-primary shadow-[0_0_0_4px_rgba(var(--primary-rgb,59,130,246),0.15)]"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-label={t("onboarding.tour.stepLabel", { n })}
        data-testid="tour-card"
        data-step={n}
        className={cn(
          "fixed z-50 w-[300px] rounded-lg border border-border bg-popover p-4 shadow-lg",
          !anchored && "-translate-x-1/2",
        )}
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("onboarding.tour.stepLabel", { n })}
          </p>
          <button
            type="button"
            onClick={finish}
            aria-label={t("onboarding.tour.skip")}
            title={t("onboarding.tour.skip")}
            data-testid="tour-skip"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <h3 className="mt-1 text-sm font-semibold text-foreground">
          {t(`onboarding.tour.step${n}.title`)}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t(`onboarding.tour.step${n}.body`)}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1" aria-hidden="true">
            {STEPS.map((st) => (
              <span
                key={st.anchor}
                className={cn("h-1.5 w-1.5 rounded-full", st.anchor === STEPS[step]?.anchor ? "bg-primary" : "bg-muted-foreground/30")}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={next}
            data-testid="tour-next"
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {step < STEPS.length - 1 ? t("onboarding.tour.next") : t("onboarding.tour.finish")}
          </button>
        </div>
      </div>
    </div>
  );
}
