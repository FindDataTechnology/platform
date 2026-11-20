// assertion-kinds — the acceptance assertion closed set, in a form the web
// bundle AND the node unit tests can both read.
//
// `AcceptanceEditor` used to hold this literal inline; a `.tsx` file cannot be
// imported by plain node, so the agreement test could not pin it. Moving the
// list here keeps one copy that both sides load.
//
// Mirrors server/blueprint-validate.js TRIAL_ASSERTION_KINDS. The agreement is
// pinned by scripts/test-acceptance-kinds-agreement.mjs, not by hope.

export const TRIAL_ASSERTION_KINDS = [
  "post-materialized",
  "first-round-fired",
  "report-landed",
  "escalate-bounded",
  "llm-judged",
] as const;

export type AssertionKind = (typeof TRIAL_ASSERTION_KINDS)[number];

/** Mirrors server JUDGE_ASSERTION_CAP default. */
export const JUDGE_ASSERTION_CAP = 8;

export interface AcceptanceRow {
  id: string;
  kind: AssertionKind;
  target?: string;
  expect?: number;
  rubric?: string;
}
