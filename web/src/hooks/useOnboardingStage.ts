// useOnboardingStage — the client half of first-run-onboarding. One fetch of
// the server-reported stage on the welcome surface, a one-time lazy migration
// when the stage is unset (the legacy markers live only in this browser, so the
// client supplies them), and a forward-only advance helper. The stage is the
// single source of truth for which onboarding surface renders; local storage no
// longer decides it.

import { useCallback, useEffect, useState } from "react";

export type OnboardingStage = "new" | "role_answered" | "provisioned" | "done";

export interface OnboardingProfile {
  roles: string[];
  note: string;
  skipped: boolean;
  answeredAt: string | null;
  source: string;
}

interface ProfileResponse {
  stage: OnboardingStage | null;
  readyRoles: string[];
  profile: OnboardingProfile;
}

// Legacy markers (pre-stage-machine). `onboarding.tour.done` now means "this
// browser dismissed the old first-run tour" → treat onboarding as done and do
// NOT contact the server for it. This is the ONLY way a local marker affects
// rendering, and it only ever yields `done` (never a forward stage) — it is an
// opt-out, not progress. The e2e suite's non-onboarding specs rely on it to stay
// isolated from the shared-server stage (all specs share one owner identity).
export function legacyTourDone(): boolean {
  try {
    return localStorage.getItem("onboarding.tour.done") === "1";
  } catch {
    return false;
  }
}
function legacyDesktopDone(): boolean {
  try {
    return localStorage.getItem("onboarding.tour.desktop.done") === "1";
  } catch {
    return false;
  }
}

export function useOnboardingStage() {
  const [stage, setStage] = useState<OnboardingStage | null>(null);
  const [readyRoles, setReadyRoles] = useState<string[]>([]);
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // A browser that dismissed the old tour opts out entirely: no surfaces and
    // no server contact (so it never migrates the shared stage). See above.
    if (legacyTourDone()) {
      setStage("done");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/onboarding/profile");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let body = (await res.json()) as ProfileResponse;
      // Unset stage → migrate once, feeding this browser's legacy markers.
      if (body.stage == null) {
        const m = await fetch("/api/onboarding/migrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            legacyTourDone: legacyTourDone(),
            legacyDesktopDone: legacyDesktopDone(),
          }),
        });
        if (m.ok) {
          const mb = (await m.json()) as { stage?: OnboardingStage };
          body = { ...body, stage: mb.stage ?? body.stage };
        }
      }
      setStage(body.stage ?? "new");
      setReadyRoles(body.readyRoles ?? []);
      setProfile(body.profile ?? null);
    } catch {
      // An unreachable server leaves onboarding hidden rather than blocking.
      setStage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Forward-only advance. Optimistically reflect the target so the surface
  // leaves immediately; adopt the server's authoritative value when it answers.
  const advance = useCallback(async (to: OnboardingStage) => {
    setStage(to);
    try {
      const res = await fetch("/api/onboarding/stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, source: "client" }),
      });
      if (res.ok) {
        const b = (await res.json()) as { stage?: OnboardingStage };
        if (b.stage) setStage(b.stage);
      }
    } catch {
      /* keep the optimistic value; reload re-reads the server */
    }
  }, []);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { stage, readyRoles, profile, loading, advance, refresh, setStage };
}
