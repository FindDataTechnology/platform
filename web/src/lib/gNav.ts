// g-prefix navigation accelerator (unify-operate-states 4.3): press-and-release
// "g", then a surface slug's FIRST LETTER within the window, jumps to that
// work surface. Pure mapping lives here so node --test pins it; App.tsx wires
// the listener. Desktop parity is automatic (same code).

export type NavTarget = { slug: string; path: string };

// First-letter → slug. Collision policy: the LEAST-letters slug wins (c = chat,
// not clusters); ties resolve by this table's order (authors' precedence).
export function buildGMap(targets: NavTarget[]): Record<string, NavTarget> {
  const byLetter: Record<string, NavTarget> = {};
  for (const t of targets) {
    const letter = t.slug[0];
    if (!letter) continue;
    const incumbent = byLetter[letter];
    if (!incumbent || t.slug.length < incumbent.slug.length) byLetter[letter] = t;
  }
  return byLetter;
}

export const G_WINDOW_MS = 1200;

// State machine: null = idle; a timestamp = "g seen at". Returns the target
// path when a second key completes the chord, else null.
export function gKeyStep(
  state: { gAt: number | null },
  now: number,
  key: string,
  byLetter: Record<string, NavTarget>,
): { next: typeof state; goto: string | null } {
  const k = key.toLowerCase();
  if (k === "g" && state.gAt == null) return { next: { gAt: now }, goto: null };
  if (state.gAt != null) {
    const expired = now - state.gAt > G_WINDOW_MS;
    const hit = !expired ? byLetter[k] : undefined;
    return { next: { gAt: null }, goto: hit ? hit.path : null };
  }
  return { next: state, goto: null };
}
