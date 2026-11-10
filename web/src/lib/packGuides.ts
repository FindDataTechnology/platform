// packGuides.ts — client-side guide content keyed by pack id (R2
// add-onboarding-tutorial, design D1). Guide bodies and per-pack prompt
// suggestions are CONTENT — the same class as pack personas and skills, which
// ship zh-authoritative single-language — so they live here in zh rather than
// in the five-locale UI bundles. Everything the user SEES as chrome (card
// titles, step labels, tab names) still resolves through i18n.
//
// Sources for every guide: the pack's own marketplace description and its
// skill workflow — no invented steps. Packs without an entry here render no
// guide card and keep the default/focused prompt sets.

export interface PackGuideStep {
  title: string;
  body: string;
}

export interface PackPromptCard {
  title: string;
  text: string;
}

export interface PackGuide {
  /** Pack display name as shown in the market — kept in sync with the market listing. */
  name: string;
  /** The three-step usage guide: prepare → ask → get. */
  steps: [PackGuideStep, PackGuideStep, PackGuideStep];
  /** Four suggested prompt cards shown on the welcome state when this expert is selected. */
  prompts?: PackPromptCard[];
}

export const PACK_GUIDES: Record<string, PackGuide> = {
  // move-pack-guides-to-manifest 3.3 终态（2026-11-01）：按 pack id 的引导文案
  // 已全部离开客户端——第一批 5 支 starter 迁入 manifest v6，第二批 7 支经登录态
  // 核实全部退役（含最后一条 法律-合同，/api/packs 登录读 404）。记录保留为空
  // 壳：HelpDialog 的空态兜底与 promptsFor 通道（仅存 prompts）仍是一等设计。
};

/** The guide for a pack id, or null when the module has no content for it. */
export function guideFor(packId: string | null | undefined): PackGuide | null {
  if (!packId) return null;
  return PACK_GUIDES[packId] ?? null;
}

/** Prompt cards for a pack id — undefined when the pack has no prompt set. */
export function promptsFor(packId: string | null | undefined): PackPromptCard[] | undefined {
  return guideFor(packId)?.prompts;
}


// ── Official starter teams (add-official-starter-teams) ──────────────────────
//
// The first-run sequence: which official team a NEW user should install
// first, and what to look at once it is provisioned. The sequence is a
// product-narrative constant (D1), NOT user data. Each entry's guide card is
// the same PackGuide channel the market detail consumes; the unit test pins
// the card's post list to the seed manifest (docs/fleet-templates/*.seed.json)
// so the card can never drift from the thing it describes.
//
// 首选 = 客服班组：恰 3 岗、4h 节奏直观、种子自带「凭据缺位如实降级」的示范——
// 新用户第一课正好是平台最核心的诚实纪律。

export interface StarterTeam {
  /** Market pack id (stable across versions — same-id republish). */
  packId: string;
  /** Display name — byte-identical to the market listing. */
  name: string;
  /** Sequence role. */
  role: "preferred" | "secondary" | "advanced";
  /** One-line positioning shown in the sequence. */
  oneLine: string;
  /** The seed manifest this team is cast from (test alignment source). */
  seedFile: string;
}

export const STARTER_TEAMS: StarterTeam[] = [
  {
    packId: "EMGW14N8voa1b36LSuTxxw",
    name: "客服班组",
    role: "preferred",
    oneLine: "三岗客服班组：组长巡检、一线处理、质检抽检——最小满编，节奏最直观",
    seedFile: "service-desk-fleet.seed.json",
  },
  {
    packId: "aofNf6o2LR61lPK8IVVkJw",
    name: "AI 公司",
    role: "secondary",
    oneLine: "全景示范：CEO 巡视 + 多部门 + 引用岗 + 降级岗，看一支「公司」怎么编",
    seedFile: "company-fleet.seed.json",
  },
  {
    packId: "tkHe8IHE0BuDYYIg5LglUw",
    name: "内容流水线",
    role: "secondary",
    oneLine: "主编→策划→撰稿→审校的周流水线，看接棒与协作怎么编",
    seedFile: "content-factory-fleet.seed.json",
  },
  {
    packId: "YMSt-hRNiNWXrlLYC8PSiA",
    name: "投研晨会",
    role: "advanced",
    oneLine: "三层级联晨会：研究员→首席→拍板上行，风控被动岗按需唤醒",
    seedFile: "invest-morning-fleet.seed.json",
  },
  {
    packId: "56opYgliV9FYAmhmsDIJOw",
    name: "晨报情报站",
    role: "advanced",
    oneLine: "每日晨报：双情报员分头巡检，主编 8 点合成，外加团队引用岗",
    seedFile: "intel-brief-fleet.seed.json",
  },
];

// The guide cards ride the SAME channel as every other pack guide — keyed by
// the market pack id. Card copy is zh-authoritative content (same class as
// personas/skills); the posts named here must match the seed manifest (test).
