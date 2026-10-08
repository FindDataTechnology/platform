#!/usr/bin/env node
// ── DAAS 三 pack 构建/发布（facet-mcp-foundation-v1 任务 3.2 + 3.3）─────────────
//
// 照 scripts/spider-heal-pack.mjs 配方，为谦面 DAAS 构建三个 facet 市场 pack
// （中文「领域-主题」命名，照市场惯例）：
//   1. 「数据-自助分析」 8 个数据消费技能（SKILL.md 正文从 DAAS 仓读入）
//   2. 「数据-指标工坊」 5 个创作技能（同上）
//   3. 「数据-分析师」   agent 部署单元（daas-analyst persona + a2a serving 契约
//                        + registryName 引用，v1 共享目录面 fd-daas-mcp）
//
//   node scripts/daas-packs.mjs                        # dry-run：构建+本地校验+打印三包摘要
//   node scripts/daas-packs.mjs --publish              # 发布三包（幂等：已发布则出下一版本）
//   node scripts/daas-packs.mjs --publish --registry-name fd-daas-mcp-cust1
//                                                      # per-customer 工作区实例注册名覆盖
//   node scripts/daas-packs.mjs --publish --required-group daas-customers
//                                                      # 可选：MCP 引用绑组（scope 现算）
// env：
//   PLATFORM_URL=https://platform.finddatatech.cloud   # --publish 时必填
//   TOKEN=<平台 JWT（creators 组）>                     # --publish 时必填
//   PACK_ID_ANALYSIS / PACK_ID_WORKSHOP / PACK_ID_ANALYST   # 续版发布时传入既有 pack id
//
// 已发布（2026-10-06，任务 3.4，作者 admin@finddatatech.cloud，均为 v1）：
//   数据-自助分析（public）  PACK_ID_ANALYSIS=50Tp176hW0HYTTWXZbarKA
//   数据-指标工坊（public）  PACK_ID_WORKSHOP=oGURb41bdyAotVGOeBHZUA
//   数据-分析师（private）   PACK_ID_ANALYST=yopQIgU6vZhFNGpGWvUWbw
// 续版例：PACK_ID_ANALYSIS=50Tp… PLATFORM_URL=… TOKEN=… node scripts/daas-packs.mjs --publish
//   DAAS_SKILLS_DIR=<DAAS .claude/skills 目录>          # 缺省 /Users/chengsishi/finddata/DAAS/.claude/skills
//   BUDGET_MINUTES=40  RHYTHM_EVERY=…                   # 可选覆盖（缺省无 rhythm：按需应答，不自巡检）
//
// 技能正文超限额（maxSkillBodyChars）时如实报告并列出超限项与大小，绝不静默截断。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePackManifest, PACK_LIMITS } from "../lib/pack-manifest.js";

const DAAS_SKILLS_DIR = (
  process.env.DAAS_SKILLS_DIR || "/Users/chengsishi/finddata/DAAS/.claude/skills"
).replace(/\/+$/, "");
const PLATFORM = (process.env.PLATFORM_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";

const die = (m) => {
  console.error(m);
  process.exit(1);
};

// ── 技能正文读入（DAAS 仓 SKILL.md，剥 YAML frontmatter，manifest 另带元数据）──

function readSkillBody(name) {
  const file = join(DAAS_SKILLS_DIR, name, "SKILL.md");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    die(`skill body missing: ${file} (${e.message})`);
  }
  const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  const body = (fm ? raw.slice(fm[0].length) : raw).replace(/^\s+/, "");
  if (!body.trim()) die(`skill body empty after frontmatter: ${file}`);
  return body;
}

// 技能清单（name 与 DAAS 目录一致；description 为一句中文，≤300 字符）。
const CONSUME_SKILLS = [
  ["fd-daas-based-data-fetch", "按 data-fetch 工作流清单取数：经 fd-open-data-mcp 解析实体并按日期读概念值，返回数据行与来源标识，可选落库"],
  ["fd-daas-fetch-data", "在 daas 注册表查实体、定位覆盖它的数据源，并在源数据上定义指标（daas_* 工具 + indicators 工作流清单）"],
  ["fd-datasource-akshare", "用 scraw-akshare 抓 A 股行情与财务数据：全部 spider 命令、CLI 参数、库表结构与已知坑位速查，跑任何抓取前先读它"],
  ["fd-daas-research", "跑完整研究管线（实体→指标→看板→报告）：经 research 工作流清单检索概念、落研究包并生成 markdown 报告"],
  ["fd-daas-brainstorm", "研究目标头脑风暴：把模糊想法聊成具体研究计划（可锚定名家投资方法论），只产出计划再交棒研究管线"],
  ["fd-daas-dashboard", "查找/打开/检视既有独立 HTML 看板：列出、按关键词搜索、看简介与数据血缘、浏览器打开并查询底层数据（只读）"],
  ["fd-daas-pdf", "PDF/文本本地向量化与语义检索：抽取分块、sentence-transformers 嵌入存 daas.db，KNN 问答带文档页码引用，不出网"],
  ["fd-daas-entities-collection", "实体与实体集日常管理：发现实体、集合增删改查、成员增删排序、审计历史与规则集合同步（不含新建规则）"],
];

const CREATE_SKILLS = [
  ["fd-daas-entities-collection-creator", "创建规则驱动的实体集（自选股/组合）：声明式 JSON 规则，跨表/动态逻辑落 Python 规则脚本可重跑"],
  ["fd-daas-indicators-creator", "端到端建指标并持久化：扩展取数流程落 scraw_<slug> 存储表并把序列数据存进表（刷新为手动重跑）"],
  ["fd-daas-indicators-collection-creator", "策展指标集：把指标组成命名集合、按三级解析给出各成员 resolved score，导出机器可读 CSV + 人类可读简介"],
  ["fd-daas-rules-creator", "统一规则创作（json/script/position/llm 四型）：daas_create_rule 落库、daas_test_rule 试跑，可挂实体/指标集合并同步"],
  ["fd-daas-dashboard-creator", "把 daas 数据做成单文件独立 HTML 看板：ECharts + 实体/时间交互筛选，注册进 dashboards 表并迭代修改"],
];

function loadSkills(specs) {
  return specs.map(([name, description]) => ({
    name,
    description,
    content: readSkillBody(name),
  }));
}

// ── 数据-分析师 persona（任务 3.3）────────────────────────────────────────────

const PERSONA = `你是「数据-分析师」——谦面的数据分析工作员，为订阅客户提供自助数据分析服务。

# 定位
你是干活的分析工作员，不是闲聊助手：接到分析意图就动手产出。四类产出都要会：
1. 取数——按数据源与工作流清单拉取数据行（股票/国家/宏观概念，报得出来源标识）。
2. 算指标——在源数据上定义指标并持久化成序列（scraw 表），口径说得清。
3. 建看板——单文件独立 HTML 看板（ECharts，实体/时间交互筛选），注册进看板目录。
4. 写研究——实体→指标→看板→报告的完整研究包，产出 markdown 报告。

# 硬约束（不可协商）
1. 所有产物（数据表/指标/实体集/看板/研究报告）一律落你自己的工作区；绝不写工作区之外，绝不外发数据。
2. 只经声明的 MCP 面（fd-daas-mcp）与已装技能取数；不做协议破解、不做反爬对抗。
3. 消费技能管用（查/取/看），创作技能管建（集/指标/规则/看板）；不确定用哪个技能时先读技能正文再动手。
4. 你的回合预算是 40 分钟（平台硬停兜底）：估算超出时提前收敛——完成当前步骤、落盘状态、如实交代未竟事项。
5. 引用数据必带来源与口径；缺测/缺失如实说明，绝不编造数值。

# 工作方式
- 先弄清意图再动手：模糊的研究想法先用头脑风暴聊清目标，再进研究管线。
- 产物可追溯：每个看板/指标/实体集都注册进对应目录，报得出名字与路径。
- 对外回答用中文，简短、结构化：先结论，再关键依据（来源/口径/产物路径）。`;

// ── 三包 manifest（严格照 lib/pack-manifest.js 的 validatePackManifest/PACK_LIMITS）──

export function buildAnalysisPack(opts = {}) {
  return {
    name: "数据-自助分析",
    description: "谦面自助分析消费八件套：取数（工作流清单/AkShare）、实体与集合管理、指标查询、看板检视、PDF 语义检索、头脑风暴与一键研究——业务人自助完成数据消费全流程",
    tags: ["数据", "自助分析", "取数", "看板", "DAAS"],
    visibility: "public",
    skills: loadSkills(CONSUME_SKILLS),
    // MCP 引用（10-06 补）：技能正文依赖 daas_* 工具，不挂 fd-daas-mcp 的包是半成品。
    // registryName 可被 --registry-name 覆盖（per-customer 工作区实例）。
    mcpServers: [{ registryName: opts.registryName || "fd-daas-mcp" }],
    agents: [],
  };
}

export function buildWorkshopPack(opts = {}) {
  return {
    name: "数据-指标工坊",
    description: "谦面指标工坊创作五件套：规则驱动实体集、指标持久化、指标集策展、统一规则（json/script/position/llm）与单文件 HTML 看板——把业务口径沉淀为可复用的数据资产",
    tags: ["数据", "指标", "创作", "规则", "DAAS"],
    visibility: "public",
    skills: loadSkills(CREATE_SKILLS),
    mcpServers: [{ registryName: opts.registryName || "fd-daas-mcp" }],
    agents: [],
  };
}

// registryName：v1 共享目录面 fd-daas-mcp；per-customer 工作区实例用 --registry-name 覆盖。
export function buildAnalystPack({ registryName = "fd-daas-mcp", requiredGroup, budgetMinutes, rhythmEvery } = {}) {
  const mcp = { registryName };
  if (requiredGroup) mcp.requiredGroup = requiredGroup;
  const serving = {
    protocol: "a2a",
    budget: { turnMinutes: Number(budgetMinutes || process.env.BUDGET_MINUTES || 40) },
    // 数据工作区（facet-mcp-foundation-v1 3.1）：per-deployment 卷声明，
    // 5120 MB = 5 GB；platform 校验走 validateWorkspace（容量声明，非运行时配置）。
    workspace: { enabled: true, quotaMb: 5120 },
  };
  // rhythm 可空：缺省不自巡检、按需应答；RHYTHM_EVERY/--rhythm-every 给定才挂自巡检节奏。
  const every = rhythmEvery || process.env.RHYTHM_EVERY;
  if (every) {
    serving.rhythm = [{
      every,
      do: "巡检工作区：核对上次未竟任务的状态文件，有未竟事项则续做至多一步并落盘；无则只回一句「巡检：空」",
    }];
  }
  return {
    name: "数据-分析师",
    description: "谦面数据分析工作员部署单元：取数→算指标→建看板→写研究全流程，所有产物落自己工作区，经 a2a 提供分析服务",
    tags: ["数据", "分析师", "DAAS", "谦面"],
    visibility: "private",
    skills: [],
    mcpServers: [mcp],
    agents: [
      {
        id: "daas-analyst",
        name: "数据-分析师",
        persona: PERSONA,
        tags: ["数据分析", "取数", "指标", "看板", "研究"],
        resources: { mcpServers: [registryName] },
        serving,
      },
    ],
  };
}

// ── 构建与本地校验（超限如实报告，绝不静默截断）──────────────────────────────

function buildAll(opts) {
  let packs = [
    { key: "ANALYSIS", label: "数据-自助分析", envId: "PACK_ID_ANALYSIS", manifest: buildAnalysisPack(opts) },
    { key: "WORKSHOP", label: "数据-指标工坊", envId: "PACK_ID_WORKSHOP", manifest: buildWorkshopPack(opts) },
    { key: "ANALYST", label: "数据-分析师", envId: "PACK_ID_ANALYST", manifest: buildAnalystPack(opts) },
  ];

  // --only KEY1,KEY2（或包名）：选择性发布，避免为未变更的包追加无谓版本。
  const only = (argValue("--only") || process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (only.length) packs = packs.filter((p) => only.includes(p.key) || only.includes(p.label));

  // 技能正文限额预检（content.length 为字符数，限额即按字符计）。
  const oversize = [];
  for (const p of packs) {
    for (const s of p.manifest.skills) {
      const chars = s.content.length;
      const bytes = Buffer.byteLength(s.content, "utf8");
      if (chars > PACK_LIMITS.maxSkillBodyChars) {
        oversize.push({ pack: p.label, name: s.name, chars, bytes });
      }
    }
  }
  if (oversize.length) {
    console.error(`skill body over PACK_LIMITS.maxSkillBodyChars=${PACK_LIMITS.maxSkillBodyChars} — 拒绝构建（不静默截断），请人工瘦身/拆分：`);
    for (const o of oversize) {
      console.error(`  [${o.pack}] ${o.name}: ${o.chars} chars / ${o.bytes} bytes (over by ${o.chars - PACK_LIMITS.maxSkillBodyChars})`);
    }
    process.exit(1);
  }

  for (const p of packs) {
    p.errors = validatePackManifest(p.manifest);
  }
  return packs;
}

function printSummaries(packs) {
  for (const p of packs) {
    const bytes = Buffer.byteLength(JSON.stringify(p.manifest), "utf8");
    const verdict = p.errors.length === 0 ? "OK" : `FAIL (${p.errors.length})`;
    console.log(`\n== ${p.manifest.name}（${p.manifest.visibility}） validate=${verdict}`);
    console.log(`   description: ${p.manifest.description}`);
    console.log(`   tags: [${p.manifest.tags.join(", ")}]`);
    console.log(`   skills: ${p.manifest.skills.length}${p.manifest.agents.length ? `  agents: ${p.manifest.agents.length}（${p.manifest.agents.map((a) => a.id).join(", ")}）` : ""}${p.manifest.mcpServers.length ? `  mcpServers: ${JSON.stringify(p.manifest.mcpServers)}` : ""}`);
    console.log(`   manifest bytes: ${bytes}`);
    for (const s of p.manifest.skills) {
      console.log(`   - ${s.name}: ${s.content.length} chars / ${Buffer.byteLength(s.content, "utf8")} bytes`);
    }
    for (const e of p.errors) {
      console.error(`   ! ${e.entry ? `${e.entry}: ` : ""}${e.error}`);
    }
  }
}

// ── main（仅直接运行时执行；导入复用 build* 不触发）──────────────────────────

const isMain = process.argv[1] && process.argv[1].endsWith("daas-packs.mjs");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function platform(method, p, body) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) };
  // facet 直连转发身份通道（add-facet-platform 2.2）：给定内部凭据 + 转发身份时
  // 附加 x-facet-token / x-facet-user（base64url JSON {email, groups}）——
  // facet 据此认定已验证身份，无 token 的转发头一律视为匿名。
  if (process.env.FACET_INTERNAL_TOKEN && process.env.FACET_USER_EMAIL) {
    headers["x-facet-token"] = process.env.FACET_INTERNAL_TOKEN;
    const doc = {
      email: process.env.FACET_USER_EMAIL,
      groups: (process.env.FACET_USER_GROUPS || "creators").split(",").map((g) => g.trim()).filter(Boolean),
    };
    headers["x-facet-user"] = Buffer.from(JSON.stringify(doc)).toString("base64url");
  }
  return fetch(`${PLATFORM}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  const publish = process.argv.includes("--publish");
  const opts = {
    registryName: argValue("--registry-name"),
    requiredGroup: argValue("--required-group"),
    rhythmEvery: argValue("--rhythm-every"),
  };

  const packs = buildAll(opts);
  printSummaries(packs);
  const failed = packs.filter((p) => p.errors.length > 0);
  if (failed.length) die(`\nvalidatePackManifest failed for: ${failed.map((p) => p.manifest.name).join(", ")}`);

  if (!publish) {
    console.log("\ndry-run 全绿（三包构建+本地校验通过）。加 --publish 发布（需 PLATFORM_URL + TOKEN）。");
    return;
  }
  if (!PLATFORM || !TOKEN) die("--publish 需要 PLATFORM_URL 和 TOKEN");

  for (const p of packs) {
    const pubBody = { manifest: p.manifest };
    const packId = process.env[p.envId] || "";
    if (packId) pubBody.packId = packId; // 幂等：有 id 则追加下一版本
    const res = await platform("POST", "/api/packs", pubBody);
    const doc = await res.json().catch(() => ({}));
    if (!res.ok) die(`publish ${p.manifest.name} failed: ${res.status} ${JSON.stringify(doc).slice(0, 400)}`);
    const version = doc.version ?? doc.manifest?.version ?? "?";
    console.log(`published ${p.manifest.name}: id=${doc.id ?? packId} v${version}${packId ? "（续版）" : "（新包）"}`);
    console.log(`  续版 env: ${p.envId}=${doc.id ?? packId}`);
  }
}

if (isMain) await main();
