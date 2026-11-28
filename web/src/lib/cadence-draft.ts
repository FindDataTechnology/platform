// cadence-draft — the 节奏语法糖 shared by BOTH member-authoring surfaces
// (complete-team-authoring-loop 2.1, design D2).
//
// The live fleet's 建岗 dialog and the workspace's 岗位抽屉 must turn the same
// four choices (被动 / 每小时 / 每天 / 自定义) into the same cron string. They
// did not share one before: the live dialog's copy lived inline in
// FleetsPage.tsx and the workspace had no cadence editor at all. Duplicating it
// a second time would let the two surfaces drift on the one field whose
// semantics ("每天 09:00" meaning what, exactly) a user cannot verify by eye.
//
// Pure and dependency-free so both the React surfaces and the node unit tests
// read the exact same bytes.

export type CadenceMode = "none" | "hourly" | "daily" | "custom";

export interface CadenceDraft {
  mode: CadenceMode;
  /** "HH:MM" — only meaningful for mode "daily". */
  time: string;
  /** Raw cron — only meaningful for mode "custom". */
  cron: string;
  tz: string;
  promptTemplate: string;
}

/** The subset of the fleet member cadence shape this lib produces. */
export interface ResolvedCadence {
  cron: string;
  tz: string | null;
  promptTemplate: string;
  enabled: boolean;
}

export function emptyCadenceDraft(): CadenceDraft {
  return { mode: "none", time: "09:00", cron: "", tz: "", promptTemplate: "" };
}

/**
 * Draft → the cadence object the write faces accept, or null for 被动.
 *
 * Contract details that are load-bearing and easy to get wrong:
 *   - 被动 (mode "none") is null, not an object with enabled:false — the fleet
 *     write path treats an absent cadence as "passive post" and a present one
 *     as scheduled.
 *   - 每天 carries the chosen HH:MM; a malformed time falls back to 09:00
 *     rather than emitting an invalid cron (the server would reject it, and a
 *     rejection here would read as "the form is broken").
 *   - tz is trimmed to null when blank so the server applies its own default.
 */
export function resolveCadence(d: CadenceDraft): ResolvedCadence | null {
  if (d.mode === "none") return null;
  let cron = d.cron.trim();
  if (d.mode === "hourly") cron = "0 * * * *";
  if (d.mode === "daily") {
    // `Number(x) || default` is WRONG here: 0 is a valid hour and a valid
    // minute, and it is falsy. "00:05" compiled to "5 9 * * *" — a schedule
    // silently moved nine hours, and the inverse reads it back as 09:05, so
    // the user's original value is gone with nothing to notice. Only NaN may
    // take the fallback.
    const [h, m] = (d.time || "09:00").split(":");
    const hh = Number(h);
    const mm = Number(m);
    cron = `${Number.isFinite(mm) ? mm : 0} ${Number.isFinite(hh) ? hh : 9} * * *`;
  }
  if (!cron) return null;
  return { cron, tz: d.tz.trim() || null, promptTemplate: d.promptTemplate, enabled: true };
}

/**
 * Existing cadence → a draft, for editing a post that already has one.
 * Returns 被动 for null/absent. Recognizes the two shapes resolveCadence
 * emits; anything else stays 自定义 so the user's real cron is never rewritten
 * into a form value it did not come from.
 */
export function cadenceToDraft(cadence: { cron?: string; tz?: string | null; promptTemplate?: string } | null | undefined): CadenceDraft {
  const base = emptyCadenceDraft();
  if (!cadence || typeof cadence.cron !== "string" || !cadence.cron.trim()) return base;
  const cron = cadence.cron.trim();
  const tz = cadence.tz ?? "";
  const promptTemplate = cadence.promptTemplate ?? "";
  if (cron === "0 * * * *") return { ...base, mode: "hourly", tz, promptTemplate };
  // 每天: "<m> <h> * * *" — only when the last three fields are exactly "* * *".
  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron);
  if (daily) {
    const h = String(Number(daily[2]) || 0).padStart(2, "0");
    const m = String(Number(daily[1]) || 0).padStart(2, "0");
    return { ...base, mode: "daily", time: `${h}:${m}`, tz, promptTemplate };
  }
  return { ...base, mode: "custom", cron, tz, promptTemplate };
}
