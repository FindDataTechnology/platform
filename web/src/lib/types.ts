// Flow board wire types (add-task-flow).
//
// Deliberately a MIRROR of the server shapes, not a re-derivation: a card is a
// task record with a `flow` passthrough field, so everything the engine already
// emits rides here unchanged and only `flow` is new.

export interface FlowAcceptance {
  id: string;
  kind: string;
  target?: string | null;
  expect?: string | number | null;
  rubric?: string;
}

export interface FlowStation {
  stationId: string;
  label?: string | null;
  target: { kind: "persona" | "a2a" | "cluster" | "tool"; ref: string | null };
  acceptance: FlowAcceptance[];
}

export interface FlowDeclaration {
  flowId: string;
  name: string;
  stations: FlowStation[];
}

export interface FlowVerdict {
  outcome: "pass" | "returned";
  by?: "criteria" | "override";
  reason?: string | null;
  actor?: string | null;
  at?: string;
  evaluation?: unknown;
}

/** The passthrough field the engine owns and never interprets. */
export interface FlowAttribution {
  flowId?: string | null;
  stationId?: string | null;
  sortKey?: string | null;
  acceptance?: FlowAcceptance[];
  stakedAt?: string | null;
  /**
   * Set by the dispatch verb. Lives INSIDE the attribution rather than as a
   * second engine passthrough key: it is a flow-layer fact, and every field
   * added to the task record is another thing the engine must carry for no
   * reason of its own.
   */
  dispatchedAt?: string | null;
  verdict?: FlowVerdict | null;
}

export interface FlowCard {
  id: string;
  title?: string | null;
  prompt: string;
  state?: string | null;
  error?: string | null;
  sessionId?: string | null;
  paused?: boolean;
  flow?: FlowAttribution | null;
  blockedBy?: string[];
  history?: { state?: string; success?: boolean | null; error?: string | null; time?: string }[];
}
