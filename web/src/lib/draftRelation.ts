// Draft ↔ published relation (complete-creator-loop 3.x).
//
// The creator needs one line answering "am I looking at what is live?", and it
// has to be derived — a stored dirty flag would be a third thing to keep true
// (design D4). The server stores the client's manifest verbatim
// (`JSON.stringify(manifest)` on publish), so a canonical comparison of the
// compiled draft against the published manifest is the honest judge.
//
// Bias: a false "ahead" only suggests publishing again; a false "same" hides
// real work. So ONLY structural equality reports same — anything else is ahead.

export type DraftRelation =
  | { state: "never-published" }
  | { state: "same"; version: number }
  | { state: "ahead"; version: number };

/** Recursive key-sorted JSON. Arrays keep their order (it is meaningful for
 *  guide steps and skill lists); objects must not depend on insertion order. */
export function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner === undefined) continue; // absent ≡ undefined, not a change
        out[key] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function draftRelation(input: {
  /** Latest published version number, or null when the draft has none. */
  version: number | null | undefined;
  /** The published version's manifest, or null while it is unknown. */
  publishedManifest: unknown;
  /** The manifest the draft would publish right now. */
  draftManifest: unknown;
}): DraftRelation {
  const version = typeof input.version === "number" && input.version > 0 ? input.version : null;
  if (version === null || input.publishedManifest == null) return { state: "never-published" };
  const same = canonicalize(input.publishedManifest) === canonicalize(input.draftManifest);
  return same ? { state: "same", version } : { state: "ahead", version };
}
