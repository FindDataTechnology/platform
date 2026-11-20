// Onboarding recipes (openspec: intent-onboarding; ADR-0027). The curated
// mapping from a business role to what a new user gets provisioned: which
// packs to install, which expert to select, which prompt source the welcome
// cards should follow, and which layout preset key the role rides.
//
// Recipes are platform-curated static data, invisible to users. They are NOT
// packs (ADR-0027): a pack is a versioned resource bundle subscribers install;
// a recipe is a first-run assembly strategy for a role — and roles are finer
// than packs (economic/financial/stock share two data packs and differ only in
// the default expert and prompts).
//
// NOTE (add-role-landing-board): `prompts` is a RESERVED field. It is built into
// the provisioning plan and read by nobody: the client's per-pack prompt
// content module (`web/src/lib/packGuides.ts`) retired to an empty shell, and no
// surface consumes the plan's `prompts` value. Do not treat it as a contract —
// reviving role-driven welcome prompts is `chat-welcome-state`'s change, and it
// owns this field then.
//
// `ready` gates the questionnaire: only roles with a complete recipe are
// offered, so a user can never pick a role that provisions nothing. Roles
// without a recipe stay assignable by admins (per role-system).

// The default expert a recipe selects: a catalog agent id (dotted, as the
// picker and the persisted preference speak it) or the built-in "local".
export interface RoleRecipe {
  /**
   * Marketplace pack references, in order. A reference is the pack's authored
   * DISPLAY NAME, not its id: the market mints ids randomly per deployment
   * (`randomBytes(16)`, gateway/packs.js), so a curated static table cannot
   * hold one. The name is authored content and stable across deployments; the
   * plan resolves it to the deployment's id at build time.
   */
  packs: string[];
  /** The expert to select after provisioning. */
  defaultExpert: string;
  /** Which pack's client prompt set the welcome cards follow (a display name). */
  prompts: string | null;
  /** The layout preset key this role rides (layout-configuration's space). */
  layoutPreset: string;
  /**
   * The surface this role starts on (add-role-landing-board). Same shape a
   * layout preset's `landing` accepts: a nav registry slug path or
   * `/boards/<served line>`. Omit it and the role inherits the deployment
   * default landing and finally `/chat`.
   *
   * Setting this does NOT require setting `layoutPreset`, and the two are
   * never inferred from one another.
   */
  landing?: string;
}

export interface RecipeCatalog {
  version: 1;
  ready: string[];
  recipes: Record<string, RoleRecipe>;
}

// v1 recipes. Pack references are the vertical packs' market display names
// (add-team-building-first-run 1.1: the pre-2026-11-05 names 法律-合同 /
// 数据-股票 / 数据-中国经济 had all been renamed in the market, and resolution
// is an exact display-name match — so every recipe silently degraded to
// "unavailable"). A reference that resolves to nothing at provision time still
// degrades to "unavailable" rather than failing the run (design D3); the
// resolution now also retries after normalizing the `·` separator.
//
// The expert ids are the personas those packs publish — they live in the
// deployment's cloud agent catalog, so a self-hosted deployment that has no
// cloud catalog cannot select them. Provisioning substitutes the built-in
// local agent and reports the substitution (add-team-building-first-run 1.5);
// it MUST NOT report an expert it never selected.
export const RECIPE_CATALOG: RecipeCatalog = {
  version: 1,
  ready: ["legal", "stock", "economic"],
  recipes: {
    legal: {
      packs: ["识律 · 合同审查套件"],
      defaultExpert: "pack-contract-reviewer",
      prompts: "识律 · 合同审查套件",
      layoutPreset: "simple",
      // 律师的第一屏是识律看板：那是他自己的文书/检索/计费状态，比空对话有用。
      landing: "/boards/lex",
    },
    stock: {
      packs: ["柏讯 · 估值套件"],
      defaultExpert: "pack-industry-analyst",
      prompts: "柏讯 · 估值套件",
      layoutPreset: "simple",
      // 数据角色落柏讯看板（数据集/产物/需求单）。凭据未连接时前端静默回落，
      // 见 line-boards 的落点要求。
      landing: "/boards/wire",
    },
    economic: {
      packs: ["柏讯 · 宏观研究套件"],
      defaultExpert: "pack-industry-analyst-macro",
      prompts: "柏讯 · 宏观研究套件",
      layoutPreset: "simple",
      landing: "/boards/wire",
    },
  },
};

export function recipeFor(role: string | null | undefined): RoleRecipe | null {
  if (!role) return null;
  return RECIPE_CATALOG.recipes[role] ?? null;
}

export function isRoleReady(role: string | null | undefined): boolean {
  return typeof role === "string" && RECIPE_CATALOG.ready.includes(role);
}

export function readyRoles(): string[] {
  return [...RECIPE_CATALOG.ready];
}
