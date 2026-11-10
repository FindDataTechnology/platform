// copilot-pack-context.ts — the market tab's pack-inspection feed for the
// copilot dock (add-facet-copilot D2). PackMarketView publishes the
// currently-inspected pack (id/name/version) on the detail dialog's
// lifecycle; CopilotDock subscribes and forwards it into the embed's context
// bar over the existing same-origin postMessage channel. One-way by
// construction: this module only ever publishes — the embed reads, never
// writes back — so the guide's read-only boundary holds (write intent stays
// on the action gate's propose path).

export interface CopilotPackContext {
  id: string;
  name: string;
  version: number;
}

type Listener = (ctx: CopilotPackContext | null) => void;
const listeners = new Set<Listener>();

export function publishPackInspection(ctx: CopilotPackContext | null): void {
  for (const l of listeners) l(ctx);
}

export function subscribePackInspection(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
