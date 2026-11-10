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
}

export interface RecipeCatalog {
  version: 1;
  ready: string[];
  recipes: Record<string, RoleRecipe>;
}

// v1 recipes. Pack references are the vertical packs' market display names
// (docs/vertical-packs.md: 法律-合同 / 数据-股票 / 数据-中国经济); the expert ids
// are the personas those packs publish in their manifests. A reference that
// resolves to nothing at provision time degrades to "unavailable" rather than
// failing the run (design D3).
export const RECIPE_CATALOG: RecipeCatalog = {
  version: 1,
  ready: ["legal", "stock", "economic"],
  recipes: {
    legal: {
      packs: ["法律-合同"],
      defaultExpert: "pack-contract-reviewer",
      prompts: "法律-合同",
      layoutPreset: "simple",
    },
    stock: {
      packs: ["数据-股票"],
      defaultExpert: "pack-industry-analyst",
      prompts: "数据-股票",
      layoutPreset: "simple",
    },
    economic: {
      packs: ["数据-中国经济"],
      defaultExpert: "pack-industry-analyst-macro",
      prompts: "数据-中国经济",
      layoutPreset: "simple",
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
