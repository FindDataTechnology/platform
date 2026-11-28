// ── Copilot card: three independent axes (unify-copilot-workbench B3) ───────
//
// A copilot surface's behaviour is configured as ONE card per surface, resolved
// through the same chain as the layout (deployment → role → user, most specific
// wins). It is deliberately NOT a fourth layout container: the layout's three
// containers are page-visibility containers with one axis each, while a copilot
// card has three axes that move independently (shell / context / tools), and
// folding it in would give that closed set a kind of member it was never meant
// to hold (see the change's design D5/D8).
//
// PER-AXIS RESOLUTION, NOT WHOLE-CARD: each axis falls back on its own. A user
// who drags the dock wider must not thereby pin the deployment's future change
// to which assistant this surface defaults to — that is the classic bug of
// copying a whole config object upward. So the user layer stores an OVERRIDE
// for the axes it touched, never a snapshot of the whole card.

export type CopilotSurface = "chat" | "dock" | "zhiyu" | "wanxing";

export const COPILOT_SURFACES: readonly CopilotSurface[] = ["chat", "dock", "zhiyu", "wanxing"];

export type CopilotPlacement = "left" | "right" | "float" | "full";

export interface CopilotShell {
  placement: CopilotPlacement;
  /** Width/height caps in px. `min` guards against an unusable sliver. */
  size: { width: number; height: number; minWidth: number; minHeight: number };
  pinned: boolean;
  defaultOpen: boolean;
}

export interface CopilotTools {
  /** The assistant this surface switches to by default (null = whatever the
   *  runtime is already on). This is a DEFAULT VALUE, not isolation: preset is
   *  runtime-scoped (one preset per cell at a time), so two surfaces cannot run
   *  different assistants simultaneously — see the copilot-workbench spec. */
  presetId: string | null;
  /** Read tools this surface may expose. Empty = talk and propose only. */
  readTools: string[];
  /** Always true. Writes go through propose_action, never a tool. */
  proposeOnly: true;
}

export interface CopilotCard {
  shell: CopilotShell;
  /** Host context keys this surface submits with each turn. */
  context: string[];
  tools: CopilotTools;
}

/** A partial card: any axis may be absent or partial. */
export interface CopilotCardPatch {
  shell?: Partial<Omit<CopilotShell, "size">> & { size?: Partial<CopilotShell["size"]> };
  context?: string[];
  tools?: Partial<Omit<CopilotTools, "proposeOnly">>;
}

/**
 * The final fallback: what the product did BEFORE cards existed. Every value
 * here matches the constants the dock shipped with, so a deployment that never
 * configures anything sees byte-identical behaviour (the change's migration
 * contract).
 */
export const BUILTIN_COPILOT_CARD: CopilotCard = {
  shell: {
    placement: "left",
    size: { width: 420, height: 0, minWidth: 320, minHeight: 240 },
    pinned: false,
    defaultOpen: false,
  },
  context: [],
  tools: { presetId: null, readTools: [], proposeOnly: true },
};

/** Per-surface built-in differences (only where the product genuinely differs). */
function builtinForSurface(surface: CopilotSurface): CopilotCard {
  if (surface === "dock") {
    return {
      ...BUILTIN_COPILOT_CARD,
      // The dock is the one surface with a board in front of it.
      context: ["line", "page", "board", "viewSummary", "selection"],
      tools: { presetId: null, readTools: ["board_read"], proposeOnly: true },
    };
  }
  if (surface === "chat") {
    // No dock entry on /chat (web-chat-ui); a card exists so the surface can be
    // described, not so a second conversation can be mounted there.
    return { ...BUILTIN_COPILOT_CARD, shell: { ...BUILTIN_COPILOT_CARD.shell, defaultOpen: false } };
  }
  return BUILTIN_COPILOT_CARD;
}

const PLACEMENTS: readonly CopilotPlacement[] = ["left", "right", "float", "full"];

/** Clamp a numeric size to something usable; ignore non-numbers. */
function sizeValue(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
}

/**
 * Merge one layer's patch onto a base card. Array axes REPLACE (a context list
 * is a decision, not an accumulation), scalar axes override individually.
 */
export function mergeCopilotCard(base: CopilotCard, patch: CopilotCardPatch | null | undefined): CopilotCard {
  if (!patch || typeof patch !== "object") return base;
  const shell: CopilotShell = { ...base.shell, size: { ...base.shell.size } };
  if (patch.shell && typeof patch.shell === "object") {
    const p = patch.shell;
    if (typeof p.placement === "string" && PLACEMENTS.includes(p.placement as CopilotPlacement)) {
      shell.placement = p.placement as CopilotPlacement;
    }
    if (typeof p.pinned === "boolean") shell.pinned = p.pinned;
    if (typeof p.defaultOpen === "boolean") shell.defaultOpen = p.defaultOpen;
    if (p.size && typeof p.size === "object") {
      shell.size = {
        width: sizeValue(p.size.width, shell.size.width),
        height: sizeValue(p.size.height, shell.size.height),
        minWidth: sizeValue(p.size.minWidth, shell.size.minWidth),
        minHeight: sizeValue(p.size.minHeight, shell.size.minHeight),
      };
      // A min larger than a max would make the panel unresizable.
      if (shell.size.minWidth > shell.size.width) shell.size.minWidth = shell.size.width;
      if (shell.size.minHeight > shell.size.height) shell.size.minHeight = shell.size.height;
    }
  }
  const context = Array.isArray(patch.context)
    ? patch.context.filter((k): k is string => typeof k === "string" && k.length > 0)
    : base.context;
  const tools: CopilotTools = { ...base.tools };
  if (patch.tools && typeof patch.tools === "object") {
    const pt = patch.tools;
    if (pt.presetId === null || typeof pt.presetId === "string") tools.presetId = pt.presetId;
    if (Array.isArray(pt.readTools)) {
      tools.readTools = pt.readTools.filter((k): k is string => typeof k === "string" && k.length > 0);
    }
  }
  // The invariant is not configurable: whatever a layer asks for, writes never
  // become a tool. Reasserted here rather than trusted from the input.
  tools.proposeOnly = true;
  return { shell, context, tools };
}

export interface CopilotCardLayers {
  /** deployment-level: whole or partial cards per surface. */
  deployment?: Partial<Record<CopilotSurface, CopilotCardPatch>> | null;
  /** role-level: same shape, usually narrower. */
  role?: Partial<Record<CopilotSurface, CopilotCardPatch>> | null;
  /** user-level: what this person changed by hand. Partial per axis. */
  user?: Partial<Record<CopilotSurface, CopilotCardPatch>> | null;
}

/**
 * Resolve one surface's effective card. Most specific layer wins PER AXIS, and
 * a layer's silence is not an override — so a deployment that later changes a
 * default reaches every user who never touched that axis.
 */
export function resolveCopilotCard(surface: CopilotSurface, layers: CopilotCardLayers = {}): CopilotCard {
  let card = builtinForSurface(surface);
  for (const layer of [layers.deployment, layers.role, layers.user]) {
    const patch = layer?.[surface];
    if (patch) card = mergeCopilotCard(card, patch);
  }
  return card;
}

/**
 * Parse the deployment layer from its env value (unify-copilot-workbench 3.2).
 *
 * Illegal JSON or a junk shape yields `null` — "no deployment config" — never a
 * throw. The alternative (failing the parse) would take down whatever reads the
 * cards, and the honest degradation for a bad config is the builtin, the same
 * posture as every other optional env in this app.
 *
 * An unknown surface name is DROPPED rather than kept: stored config for a
 * surface the product does not have is dead weight that later looks like a
 * feature nobody enabled.
 */
export function parseCopilotCardsEnv(raw: unknown): Partial<Record<CopilotSurface, CopilotCardPatch>> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Partial<Record<CopilotSurface, CopilotCardPatch>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(COPILOT_SURFACES as readonly string[]).includes(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    out[key as CopilotSurface] = value as CopilotCardPatch;
  }
  return Object.keys(out).length ? out : null;
}

/** True when a surface may mount a dock at all. Today only `dock` does. */
export function surfaceMountsDock(surface: CopilotSurface): boolean {
  return surface === "dock";
}
