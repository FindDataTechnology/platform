// Surface registry + layout presets (openspec: layout-configuration; ADR-0026).
//
// The single authority for WHICH surfaces exist. Three containers in v1 —
// primary navigation tabs, Settings sections, Agents page sub-tabs — each
// entry keyed by its existing public route slug (the R1 "slug is public API"
// commitment) and carrying its platform predicates and stable identity
// metadata. The web renders from this; the server resolves presets against
// it. Nothing else may hardcode a surface list.
//
// Layout resolution is a four-layer narrowing chain: factory preset →
// deployment default → business-role preset → user adjustment. Each layer may
// only HIDE or REORDER what the layer above left; nothing re-reveals.
// Deployment hiding is terminal (ADR-0026). Platform predicates are absolute
// — no preset can conjure the desktop fleet into a browser.

// ── Registry ────────────────────────────────────────────────────────────────

export type SurfaceContainer = "nav" | "settings" | "agentsTabs";

export interface SurfacePredicates {
  /** Desktop shell only (the Electron app's own runner fleet). */
  desktopOnly?: boolean;
  /** Present only where the deployment reports the pack marketplace. */
  packMarketplace?: boolean;
  /** Present only where documents are enabled. */
  documentsEnabled?: boolean;
  /** Admin-only when auth is on (mirrors the section's server gate). */
  adminOnly?: boolean;
}

export interface RegistryEntry {
  container: SurfaceContainer;
  slug: string;
  /** i18n key the label resolves from (stable across locales). */
  i18nKey: string;
  testId: string;
  predicates?: SurfacePredicates;
}

export const NAV_SURFACES: RegistryEntry[] = [
  { container: "nav", slug: "chat", i18nKey: "nav.chat", testId: "nav-chat" },
  { container: "nav", slug: "knowledge", i18nKey: "nav.knowledge", testId: "nav-knowledge" },
  { container: "nav", slug: "resources", i18nKey: "nav.resources", testId: "nav-resources" },
  // 记忆面板（add-unified-memory-and-outputs 3.3）：owner 看自己 u/ 记忆的浏览面，
  // 与资源/成果同族；萬星 console 的部署者视角经同一读取面（rootKey lane）。
  { container: "nav", slug: "memory", i18nKey: "nav.memory", testId: "nav-memory" },
  { container: "nav", slug: "agents", i18nKey: "nav.agents", testId: "nav-agents" },
  // 调优 (restructure-yizuo-ia): the skill-candidate review + persona-amendment
  // surface used to be URL-only (/tuning existed with NO link anywhere). It
  // graduates out of the agentsTabs container into primary navigation, pairing
  // with the market in the 构建 family.
  { container: "nav", slug: "tuning", i18nKey: "nav.tuning", testId: "nav-tuning" },
  // Agent fleets (agent-fleet-core): the organization layer over personas,
  // clusters and a2a services. Plain web surface — no predicate (unlike the
  // desktop-only runner console `fleet`).
  { container: "nav", slug: "fleets", i18nKey: "nav.fleets", testId: "nav-fleets" },
  // Machines console (add-unified-fleet-console): steward-paired machines
  // with derived health + desired-state editing. Plain web surface — the
  // roster is account-scoped; admins see every machine the store knows.
  { container: "nav", slug: "machines", i18nKey: "nav.machines", testId: "nav-machines" },
  // Desktop runner console (add-desktop-fleet-console). Label is 本机运行时:
  // it is the LOCAL runtime, one layer below fleets (organization) and
  // machines (paired devices) — the slug/testid stay `fleet`.
  { container: "nav", slug: "fleet", i18nKey: "nav.fleet", testId: "nav-fleet", predicates: { desktopOnly: true } },
  { container: "nav", slug: "tasks", i18nKey: "nav.tasks", testId: "nav-tasks" },
  { container: "nav", slug: "apps", i18nKey: "nav.apps", testId: "nav-apps" },
  // 渠道 (restructure-yizuo-ia): the social-bot management surface LEAVES the
  // Settings container. Talking to users on Telegram/飞书/企微/公众号 is an
  // outbound-communication work surface, not configuration.
  { container: "nav", slug: "channels", i18nKey: "nav.channels", testId: "nav-channels" },
  // 萬星·智语 (add-zhiyu-room): multi-human × multi-agent rooms. Web surface.
  { container: "nav", slug: "zhiyu", i18nKey: "nav.zhiyu", testId: "nav-zhiyu" },
  // 蓝图构造间 (add-blueprint-studio): the vertical-package authoring surface —
  // 蓝图→集群模板→上架（治包不治舰，design D1）. Plain web surface like fleets.
  // Its nav entry is retired into the workspace redirect: the slug stays for
  // stored presets and deep links, and no factory preset lists it.
  { container: "nav", slug: "blueprints", i18nKey: "nav.blueprints", testId: "nav-blueprints" },
];

// Settings section slugs in canonical order, mirroring sections.ts. The
// registry is the authority the resolver narrows; sections.ts consumes it for
// order and membership (labels/icons/components stay there — presentation
// concerns the server never needs).
export const SETTINGS_SURFACES: RegistryEntry[] = [
  { container: "settings", slug: "general", i18nKey: "settings.sections.general", testId: "settings-section-general" },
  { container: "settings", slug: "account", i18nKey: "settings.sections.account", testId: "settings-section-account" },
  // 配对与绑定 (restructure-yizuo-ia): `devices` + `wechat-app` merged. Both mint
  // from the SAME single-use 5-minute code pool, so one section with three tabs
  // (小程序 / 桌面应用 / 机器) is one concept; the two old slugs stay addressable
  // through SURFACE_SLUG_ALIASES and preselect their tab.
  { container: "settings", slug: "pairing", i18nKey: "settings.sections.pairing", testId: "settings-section-pairing" },
  { container: "settings", slug: "connections", i18nKey: "settings.sections.connections", testId: "settings-section-connections" },
  // unify-material-market: `mcp` (tools + skills management) and `plugins` left
  // the Settings container for the materials market's tabs. `models` stays —
  // choosing a provider and holding its key is configuration, not acquisition.
  { container: "settings", slug: "models", i18nKey: "settings.sections.models", testId: "settings-section-models" },
  { container: "settings", slug: "roles", i18nKey: "settings.sections.roles", testId: "settings-section-roles", predicates: { adminOnly: true } },
  { container: "settings", slug: "layout", i18nKey: "settings.sections.layout", testId: "settings-section-layout", predicates: { adminOnly: true } },
  // 委托策略 (add-deputy-decision-delegate): present in sections.ts but MISSING
  // here — and the modal renders only registry slugs, so it was permanently
  // unreachable. The registry↔definitions agreement is now a unit-tested
  // invariant (packages/core test).
  { container: "settings", slug: "delegation", i18nKey: "settings.sections.delegation", testId: "settings-section-delegation" },
  // 委托状 (add-personal-mandate 6.1): the authority matrix. Registered in both
  // lists from the start — the `delegation` bug above is why this test exists.
  { container: "settings", slug: "mandate", i18nKey: "settings.sections.mandate", testId: "settings-section-mandate" },
  { container: "settings", slug: "mandate-intake", i18nKey: "settings.sections.mandateIntake", testId: "settings-section-mandate-intake" },
  { container: "settings", slug: "branding", i18nKey: "settings.sections.branding", testId: "settings-section-branding", predicates: { adminOnly: true } },
  // 运行状态 (restructure-yizuo-ia): `diagnostics` folded in as a tab — the
  // per-turn trace is part of "what is happening right now", not a sibling
  // concept with its own door.
  { container: "settings", slug: "status", i18nKey: "settings.sections.status", testId: "settings-section-status" },
];

export const AGENTS_TAB_SURFACES: RegistryEntry[] = [
  // unify-material-market: `/agents` (slug kept — public API) is the MATERIALS
  // market: one front-of-house surface for the four capability species plus
  // 我的. Agent / MCP / skill / plugin marketplaces are daily-use surfaces, so
  // they live here rather than behind the Settings gear; 模型 stays Settings
  // because picking a provider is configuration, not acquisition.
  //
  // Retired hub slugs (build/supply/creations/apps) and the old `market` browse
  // tab all resolve through SURFACE_SLUG_ALIASES, so stored presets and legacy
  // ?tab= deep links keep landing on their content.
  // The 智能体 tab is the market's FRONT PAGE, so it always exists: a deployment
  // without a marketplace renders its honest "this deployment carries no
  // marketplace" state there. Vanishing the first tab left the surface opening
  // on 工具 and the page reading as if the market had been removed.
  { container: "agentsTabs", slug: "agents", i18nKey: "agents.tab.agents", testId: "agents-tab-agents" },
  { container: "agentsTabs", slug: "tools", i18nKey: "agents.tab.tools", testId: "agents-tab-tools" },
  { container: "agentsTabs", slug: "skills", i18nKey: "agents.tab.skills", testId: "agents-tab-skills" },
  // Plugins are always listed: the catalogue ships with the deployment even
  // when nothing is supplied, and an empty catalogue renders its explanation.
  { container: "agentsTabs", slug: "plugins", i18nKey: "agents.tab.plugins", testId: "agents-tab-plugins" },
  { container: "agentsTabs", slug: "mine", i18nKey: "agents.tab.mine", testId: "agents-tab-mine" },
];

export const SURFACE_REGISTRY: Record<SurfaceContainer, RegistryEntry[]> = {
  nav: NAV_SURFACES,
  settings: SETTINGS_SURFACES,
  agentsTabs: AGENTS_TAB_SURFACES,
};

export const SURFACE_CONTAINERS: SurfaceContainer[] = ["nav", "settings", "agentsTabs"];

// ── Nav families (add-knowledge-memory-surface D1) ──────────────────────────
// Presentation-only grouping of the nav (a Codex-style collapsible family). It
// is NOT registry data: the resolver already decided which slugs exist; a
// family only arranges the survivors, and a hidden slug simply never shows.
// The slug membership lives here (not in the client) so the client never
// re-derives which surfaces belong together.
export interface NavFamily {
  /** Stable id; the client renders the label from `nav.family.<id>`. */
  id: string;
  /** Members in registry order. */
  slugs: string[];
}

export const NAV_FAMILIES: NavFamily[] = [
  { id: "knowledge", slugs: ["knowledge", "resources", "memory"] },
  // restructure-yizuo-ia: build pairs ACQUIRE with ITERATE (market + tuning) —
  // `fleets` left for run, because composing a team is not the same act as
  // getting capability. The blueprint studio's nav entry stays retired (its
  // route is a redirect); the `blueprints` slug remains in the registry so
  // stored presets and deep links keep resolving.
  { id: "build", slugs: ["agents", "tuning"] },
  // The three layers of one concept: organization (fleets) → paired devices
  // (machines) → local runtime (fleet, desktop-only). They were three
  // near-synonym top-level entries before.
  { id: "run", slugs: ["fleets", "machines", "fleet"] },
  // Outbound / discovery: the product directory, the chat channels we answer
  // on, and the multi-human rooms.
  { id: "access", slugs: ["apps", "channels", "zhiyu"] },
];

export function registryFor(container: SurfaceContainer): RegistryEntry[] {
  return SURFACE_REGISTRY[container] ?? [];
}

// Aliases: retired/legacy slugs that still resolve to a registry slug. Kept
// next to the registry so a slug cannot be added in one place only.
// restructure-yizuo-ia: the dissolved builder hub's slugs plus the merged /
// relocated Settings slugs all canonicalize here, so stored presets and
// bookmarks keep landing on their content instead of erroring.
export const SURFACE_SLUG_ALIASES: Partial<Record<SurfaceContainer, Record<string, string>>> = {
  settings: {
    skills: "mcp",
    // devices + wechat-app merged into one pairing section (same code pool,
    // three tabs); diagnostics folded into the status section as a tab.
    devices: "pairing",
    "wechat-app": "pairing",
    diagnostics: "status",
    // channels LEFT settings for the nav container. Nothing to alias to inside
    // this container; the route layer redirects /settings/channels → /channels.
  },
  agentsTabs: {
    // unify-material-market: the pack browse tab is now `agents` (canonical),
    // so `agents` is NO alias any more. 创作(creations) → 我的; the browse-ish
    // retired slugs (market/supply/apps/build) → 智能体.
    creations: "mine",
    market: "agents",
    supply: "agents",
    apps: "agents",
    build: "agents",
  },
};

export function canonicalSlug(container: SurfaceContainer, slug: string): string {
  // A REAL registry slug always wins over an alias of the same name. Without
  // this guard, adding a canonical slug that used to be a legacy alias makes
  // the alias eat it: `agentsTabs` gained the canonical `agents` tab while the
  // retired 专家 alias `agents → mine` still existed, so every preset naming
  // `agents` silently resolved to `mine` and the tab vanished from resolution.
  if (registryFor(container).some((e) => e.slug === slug)) return slug;
  return SURFACE_SLUG_ALIASES[container]?.[slug] ?? slug;
}

// True when `slug` addresses `entry` (canonically or via an alias).
export function surfaceMatches(entry: RegistryEntry, slug: string | undefined): boolean {
  if (!slug) return false;
  return entry.slug === slug || canonicalSlug(entry.container, slug) === entry.slug;
}

// ── Predicates ──────────────────────────────────────────────────────────────

export interface PredicateFacts {
  isDesktop?: boolean;
  packMarketplace?: boolean;
  documentsEnabled?: boolean;
  isAdmin?: boolean;
  authOn?: boolean;
}

// A predicate is satisfied (surface remains) unless its fact is explicitly
// present AND adverse. Absent facts mean "unknown" and leave the surface in
// place, so a client that cannot answer (a stale config, a test harness, the
// bare registry read) never loses surfaces it would otherwise have. The
// adminOnly case follows the same rule: filtering happens only when the caller
// affirmatively states `authOn: true` and `isAdmin` is not true.
export function predicateAllows(entry: RegistryEntry, facts: PredicateFacts): boolean {
  const p = entry.predicates;
  if (!p) return true;
  if (p.desktopOnly && facts.isDesktop === false) return false;
  if (p.packMarketplace && facts.packMarketplace === false) return false;
  if (p.documentsEnabled && facts.documentsEnabled === false) return false;
  // adminOnly: drop only when we know auth is on and the user is not an admin.
  if (p.adminOnly && facts.authOn === true && facts.isAdmin !== true) return false;
  return true;
}

// ── Presets ─────────────────────────────────────────────────────────────────

export interface LayoutPreset {
  version: 1;
  nav?: string[];
  settings?: string[];
  agentsTabs?: string[];
}

export interface PresetCatalog {
  [slug: string]: LayoutPreset;
}

// The default preset names every registry slug (minus the retired nav entries)
// in canonical order, so a deployment with no layout data anywhere resolves to
// the full surface set.
export const FACTORY_PRESET_SLUG = "standard-snapshot";

// The non-technical skeleton: the four work surfaces, and Settings reduced to
// the Basics group. A preset names surfaces to KEEP; absence hides.
export const FACTORY_PRESETS: PresetCatalog = {
  [FACTORY_PRESET_SLUG]: {
    version: 1,
    // `blueprints` is the one surface the factory nav drops (nav entry retired
    // into the workspace redirect); every other registry slug stays, item for
    // item, in registry order — which is now the six-top-level / four-family
    // set (chat, knowledge×3, build×2, run×3, tasks, access×3).
    nav: NAV_SURFACES.map((s) => s.slug).filter((slug) => slug !== "blueprints"),
    settings: SETTINGS_SURFACES.map((s) => s.slug),
    // restructure-yizuo-ia: `/agents` is the single pack doorway with exactly
    // two tabs (the retired hub's four slugs stay resolvable via aliases).
    agentsTabs: ["agents", "tools", "skills", "plugins", "mine"],
  },
  simple: {
    version: 1,
    // `apps` rides in the non-technical skeleton too: the app center is the
    // discovery surface and the connection entry (every card's 去连接, the
    // 词元 account binding), and the business-role recipes are exactly the
    // users who must reach it (role-nav-apps, 2026-10-18). `tasks`/`fleet`
    // stay technical.
    nav: ["chat", "knowledge", "resources", "memory", "agents", "apps"],
    // `connections` rides in the non-technical skeleton: it is where a user
    // makes their tools and search work at all, and the business-role recipes
    // (legal/stock/economic) all resolve to this preset. Leaving it out made
    // the section invisible — and every connect deep link fell back to
    // General — for exactly the users those recipes provision (2026-10-18).
    settings: ["general", "account", "pairing", "connections"],
    agentsTabs: ["agents", "tools", "skills", "plugins", "mine"],
  },
};

export function factoryPreset(slug: string | undefined | null): LayoutPreset {
  if (slug && FACTORY_PRESETS[slug]) return FACTORY_PRESETS[slug];
  return FACTORY_PRESETS[FACTORY_PRESET_SLUG]!;
}

// Validate a stored/edited preset: known slug, correct container, no unknown
// slugs. A container may be omitted (the layer does not speak to it) — an
// empty array is allowed too and means "narrow to nothing", which resolution
// treats as no-narrowing only when it would blank the container.
export function validatePreset(preset: unknown): { ok: true; preset: LayoutPreset } | { ok: false; error: string } {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    return { ok: false, error: "preset must be an object" };
  }
  const p = preset as Partial<LayoutPreset>;
  const out: LayoutPreset = { version: 1 };
  for (const container of SURFACE_CONTAINERS) {
    const list = p[container];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `${container} must be an array` };
    const known = new Set(registryFor(container).map((e) => e.slug));
    // Legacy slugs canonicalize before the known-set check so a stored preset
    // naming a retired slug (agentsTabs: agents/market) stays valid and lands
    // on its successor (add-agent-builder-hub D5).
    const canonical = list.map((s) => (typeof s === "string" ? canonicalSlug(container, s) : s));
    for (const slug of canonical) {
      if (typeof slug !== "string") return { ok: false, error: `${container} entries must be strings` };
      if (!known.has(slug)) return { ok: false, error: `unknown ${container} surface '${slug}'` };
    }
    out[container] = [...new Set(canonical)];
  }
  return { ok: true, preset: out };
}

// ── Resolution ──────────────────────────────────────────────────────────────

// One layer's contribution: an optional preset to narrow with, plus optional
// direct hides (the deployment's terminal-hide list).
export interface LayoutLayer {
  preset?: LayoutPreset | null;
  hidden?: string[] | null;
}

export interface LayoutLayers {
  deployment?: LayoutLayer;
  role?: LayoutLayer;
  user?: LayoutLayer;
}

export interface ResolvedLayout {
  nav: string[];
  settings: string[];
  agentsTabs: string[];
}

// Narrow one container: apply each layer in order (deployment → role → user).
// A layer's preset decides membership among the slugs still present AND
// supplies their relative order (the most specific layer's order wins, which
// is how a user reorder takes effect). A preset naming slugs the previous
// layer already hid changes nothing for them (no re-reveal). A preset that
// would blank the container is treated as no-narrowing — a half-built preset
// must not empty a surface. Direct `hidden` slugs are removed last. Unknown
// slugs (stale data) are ignored, never fatal.
export function resolveContainer(container: SurfaceContainer, layers: LayoutLayers): string[] {
  let current = registryFor(container).map((e) => e.slug);
  const narrow = (layer: LayoutLayer | undefined) => {
    if (!layer) return;
    const presetList = layer.preset?.[container];
    if (Array.isArray(presetList)) {
      // Legacy slugs canonicalize first so a stored preset naming `agents`/
      // `market` narrows the successor slugs (add-agent-builder-hub D5).
      const canonList = presetList.map((s) => canonicalSlug(container, s));
      const keep = new Set(canonList);
      const survivors = current.filter((slug) => keep.has(slug));
      if (survivors.length) {
        // The preset's order governs the survivors: a user reorder is a
        // preset whose list is a permutation of the inherited survivors.
        const byPresetOrder = canonList.filter((slug) => survivors.includes(slug));
        current = byPresetOrder.length ? [...new Set(byPresetOrder)] : survivors;
      }
    }
    if (Array.isArray(layer.hidden) && layer.hidden.length) {
      const drop = new Set(layer.hidden);
      current = current.filter((slug) => !drop.has(slug));
    }
  };
  narrow(layers.deployment);
  narrow(layers.role);
  narrow(layers.user);
  return current;
}

// Full resolution across containers plus the predicate/admin filter. Predicates
// are applied LAST and absolutely: no layer can defeat them.
export function resolveLayout(layers: LayoutLayers, facts: PredicateFacts = {}): ResolvedLayout {
  // Administrators are exempt from business-role narrowing (admin-layout-exempt):
  // the role preset is the non-technical skeleton for business users, and
  // applying it to an operator hides administration surfaces the adminOnly
  // predicate alone cannot bring back (models/channels/diagnostics carry no
  // predicate). Only an affirmative admin answer with auth on counts; auth off
  // keeps narrowing so local role preview and hermetic tests still see it.
  const effective: LayoutLayers =
    facts.authOn === true && facts.isAdmin === true ? { ...layers, role: undefined } : layers;
  const out: ResolvedLayout = { nav: [], settings: [], agentsTabs: [] };
  for (const container of SURFACE_CONTAINERS) {
    const slugs = resolveContainer(container, effective);
    const allowed = new Set(
      registryFor(container)
        .filter((e) => predicateAllows(e, facts))
        .map((e) => e.slug),
    );
    out[container] = slugs.filter((s) => allowed.has(s));
  }
  return out;
}

// Parse a stored preset document (deployment config / env). Unparseable or
// invalid input degrades to null with a warning — a bad hand-edited value must
// never take the UI down.
export function parsePresetSource(raw: unknown): LayoutPreset | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn("[layout] preset source is not valid JSON; ignoring");
      return null;
    }
  }
  const result = validatePreset(parsed);
  if (!result.ok) {
    console.warn(`[layout] preset source failed validation (${result.error}); ignoring`);
    return null;
  }
  return result.preset;
}

export function parseHiddenSource(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((s): s is string => typeof s === "string");
}

// A preset slug reference (deployment default / per-role map). Unknown slugs
// resolve to the factory default rather than erroring.
export function presetBySlugOrFactory(slug: string | undefined | null, catalog: PresetCatalog = FACTORY_PRESETS): LayoutPreset {
  if (slug && catalog[slug]) return catalog[slug];
  return catalog[FACTORY_PRESET_SLUG]!;
}
