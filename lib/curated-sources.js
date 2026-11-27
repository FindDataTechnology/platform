// lib/curated-sources.js — 人工钉定的外部技能源（curated pinned upstream）
//
// 为什么需要它：货架现有的两个源（SkillHub / Smithery）是**搜索引擎**——它们
// 索引整片生态，条目会漂移、会 404、许可证恒为 unknown。精选转正的动因正是
// 不可靠。本模块给出一类相反姿态的源：**人工挑条目、钉死 commit、逐条写来源**。
//
// 与既有链路的接缝（零新增下游代码）：
//   - 它就是一个普通 adapter（list / get / fetchPackage），注册进
//     createExternalSourceRegistry，于是货架浏览与安装路径原样可用；
//   - originUrl 是 `.../tree/<sha>/<path>`，于是：
//       · resolvePinnedRevision 走 sha 快路径（不再发请求、不会被上游推进带走）
//       · collectUpstreamLicenseEvidence 先找技能目录的 LICENSE、再回落仓库根
//     —— 许可门读的是**上游原文**，本文件写的许可结论不参与判定（
//     official-adoption 规范：货架镜像态不作数）。
//
// 钉定纪律：ref 必须是 40 位 commit sha，不是分支名。分支名会让"转正时的内容"
// 与"复核时看到的内容"不是同一份——这正是 spec 要防的静默漂移。改 pin = 一次
// 可复核的改动（新 sha + 重跑许可门），不是自动跟随。

import { githubFetchDirFiles, normalizeEntry, outboundFetch, parsePackage } from "../external-sources.js";

// ── 精选源清单 ────────────────────────────────────────────────────────────────
//
// 每条 entry 只写**运营判断**（slug / 路径 / 一句话用途 / 标签），内容一律
// 运行时从 pin 的 sha 取——本文件不携带技能正文，因此不存在"清单与正文脱节"。
//
// 清单里没有的东西，以及为什么（这三类都不进来，理由各不相同）：
//   · pdf / docx / pptx / xlsx —— 许可 Proprietary（"may not create derivative
//     works" / "may not distribute"），**结构性排除**，不靠运行时门去挡。
//   · doc-coauthoring —— 无 LICENSE 文件、frontmatter 也无 license 字段，
//     按「未声明即拒绝」不入清单。
//   · claude-api —— 许可是 Apache-2.0（合法），但上游目录带 60+ 个辅助文件，
//     超过 PACKAGE_LIMITS.maxAuxFiles(64)，装不进我们的包边界；列出来只会得到
//     一张点安装就失败的卡，所以不列（实测 2026-11-03：limit-exceeded）。


export const CURATED_SOURCES = [
  {
    id: "anthropic-skills",
    displayName: "Anthropic Skills",
    owner: "anthropics",
    repo: "skills",
    // 2026-11-03 pin。main 会前进，这里不动；换 pin 是一次审校动作。
    ref: "ca45fc496a3436251f191354091d557da31c15b5",
    // 上游仓库的许可事实（只作展示与台账，判定仍走许可门读原文）。
    upstreamNote: "Per-skill licenses: 14 Apache-2.0 (listed here); 4 Proprietary (pdf/docx/pptx/xlsx, deliberately excluded); doc-coauthoring declares none.",
    entries: [
      {
        slug: "frontend-design",
        path: "skills/frontend-design",
        summaryZh: "新界面或改版时的视觉方向、字体与版式判断",
        description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one.",
        tags: ["design", "frontend"],
      },
      {
        slug: "web-artifacts-builder",
        path: "skills/web-artifacts-builder",
        summaryZh: "用 React/Tailwind/shadcn 搭建多组件 HTML 产物",
        description: "Suite of tools for creating elaborate, multi-component HTML artifacts using modern frontend web technologies.",
        tags: ["frontend", "artifacts"],
      },
      {
        slug: "webapp-testing",
        path: "skills/webapp-testing",
        summaryZh: "用 Playwright 驱动本地 Web 应用做功能验证与 UI 排查",
        description: "Toolkit for interacting with and testing local web applications using Playwright.",
        tags: ["testing", "playwright"],
      },
      {
        slug: "canvas-design",
        path: "skills/canvas-design",
        summaryZh: "海报、插画、封面等 PNG/PDF 视觉稿的设计流程",
        description: "Create visual art in .png and .pdf documents using design philosophy.",
        tags: ["design", "visual"],
      },
      {
        slug: "theme-factory",
        path: "skills/theme-factory",
        summaryZh: "给幻灯片、文档、网页套统一主题（10 套预设）",
        description: "Toolkit for styling artifacts with a theme — slides, docs, reports, HTML landing pages.",
        tags: ["design", "theme"],
      },
      {
        slug: "algorithmic-art",
        path: "skills/algorithmic-art",
        summaryZh: "用 p5.js 做带随机种子的生成艺术",
        description: "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration.",
        tags: ["design", "generative"],
      },
      {
        slug: "mcp-builder",
        path: "skills/mcp-builder",
        summaryZh: "构建高质量 MCP server 的工程指南",
        description: "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services.",
        tags: ["engineering", "mcp"],
      },
      {
        slug: "skill-creator",
        path: "skills/skill-creator",
        summaryZh: "从零写技能、改技能、量技能效果",
        description: "Create new skills, modify and improve existing skills, and measure skill performance.",
        tags: ["engineering", "meta"],
      },
      {
        slug: "slack-gif-creator",
        path: "skills/slack-gif-creator",
        summaryZh: "做 Slack 用的动图（尺寸与体积约束 + 校验工具）",
        description: "Knowledge and utilities for creating animated GIFs optimized for Slack.",
        tags: ["media", "gif"],
      },
      {
        slug: "internal-comms",
        path: "skills/internal-comms",
        summaryZh: "内部沟通文体（状态报告、周报、公告）写作模板",
        description: "A set of resources to help write internal communications using the formats a company uses.",
        tags: ["writing", "comms", "vendor-specific"],
      },
      {
        slug: "brand-guidelines",
        path: "skills/brand-guidelines",
        summaryZh: "Anthropic 官方品牌色与字体规范（套用即呈现其 look-and-feel）",
        description: "Applies Anthropic's official brand colors and typography to artifacts.",
        tags: ["design", "brand", "vendor-specific"],
      },
      {
        slug: "academy-guide",
        path: "skills/academy-guide",
        summaryZh: "回答「Claude 怎么用」时推荐对应课程",
        description: "Recommends matching courses when answering questions about how to use Claude or a Claude product.",
        tags: ["docs", "vendor-specific"],
      },
      {
        slug: "discernment-nudge",
        path: "skills/discernment-nudge",
        summaryZh: "交出可执行结论前补一句「哪些地方该自己核」",
        description: "After a substantive answer the user may act on, nudges about what deserves the user's own scrutiny.",
        tags: ["writing", "review"],
      },
    ],
  },
];

export function getCuratedSource(id) {
  return CURATED_SOURCES.find((s) => s.id === id) ?? null;
}

// 目录列举走的是 api.github.com，匿名额度只有 60 次/小时/IP —— 一个 14 条的
// 精选源逐条取包（每条约 3 次列举）就会撞墙。有 token 时只对 api.github.com
// 挂 Authorization（5000 次/小时）；没有 token 也照常工作，只是慢/易限流。
// token 永不发往其它主机（download_url 是 raw.githubusercontent）。
export function githubApiFetch(token, base = outboundFetch) {
  if (!token) return base;
  return (url, init = {}) => {
    let host = "";
    try {
      host = new URL(String(url)).hostname;
    } catch {
      return base(url, init);
    }
    if (host !== "api.github.com") return base(url, init);
    return base(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  };
}

// 一条 entry 的上游目录 URL——sha 钉死，因此这条 URL 指向的内容永不漂移。
export function curatedOriginUrl(pin, entry) {
  return `https://github.com/${pin.owner}/${pin.repo}/tree/${pin.ref}/${entry.path}`;
}

function toEntry(pin, item) {
  return normalizeEntry({
    source: pin.id,
    id: item.slug,
    name: item.slug,
    displayName: item.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: item.description || "",
    originUrl: curatedOriginUrl(pin, item),
    // 货架镜像态恒 unknown：判定权在许可门（读上游原文），不在清单。
    licenseState: "unknown",
    version: pin.ref.slice(0, 12),
    versionLayer: "curated-pin",
    tags: item.tags ?? [],
    extras: { curated: true, pinnedRevision: pin.ref, repo: `${pin.owner}/${pin.repo}`, summaryZh: item.summaryZh ?? null },
  });
}

export function createCuratedAdapter(pin, { fetchImpl } = {}) {
  const bySlug = new Map(pin.entries.map((e) => [e.slug, e]));
  const fetch = fetchImpl ?? githubApiFetch(process.env.GITHUB_TOKEN);

  async function search(q, limit) {
    const needle = String(q ?? "").trim().toLowerCase();
    const matched = pin.entries.filter((e) => {
      if (!needle) return true;
      const hay = [e.slug, e.summaryZh, e.description, ...(e.tags ?? [])].join(" ").toLowerCase();
      return hay.includes(needle);
    });
    return matched.slice(0, limit).map((e) => toEntry(pin, e));
  }

  async function get(slug) {
    const item = bySlug.get(String(slug ?? ""));
    return item ? toEntry(pin, item) : null;
  }

  // 取包即取"钉定 sha 下的那个目录"——pin 在 URL 里，所以这条路不可能拿到
  // 别的版本；不需要事后再核 revision。
  async function fetchPackage(slug) {
    const item = bySlug.get(String(slug ?? ""));
    if (!item) {
      throw Object.assign(new Error(`not a curated entry: ${pin.id}/${slug}`), { code: "upstream-not-found" });
    }
    try {
      const raw = await githubFetchDirFiles(pin.owner, pin.repo, pin.ref, item.path, { fetchImpl: fetch });
      return parsePackage(raw);
    } catch (err) {
      if (err.code === "upstream-not-found") {
        throw Object.assign(new Error(`pinned upstream directory not found: ${curatedOriginUrl(pin, item)}`), {
          code: "upstream-not-found",
          cause: err,
        });
      }
      throw err;
    }
  }

  return { id: pin.id, displayName: pin.displayName, list: search, get, fetchPackage };
}

export function createCuratedAdapters({ fetchImpl } = {}) {
  return CURATED_SOURCES.map((pin) => createCuratedAdapter(pin, { fetchImpl }));
}
