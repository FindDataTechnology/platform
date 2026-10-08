// Pure helpers for the mini-program home showcase (openspec:
// redesign-mp-home). No Taro imports — testable under plain node --test via
// type stripping (the markdown.test.mjs pattern).

import type { AgentInfo, SessionMeta } from "@platform/core";

export interface ShowcaseCard {
  id: string;
  name: string;
  description: string;
  general: boolean; // the built-in assistant quick start, pinned first
}

const GENERAL_DESCRIPTION = "问答 · 写作 · 检索 · 技能调用";

// The welcome grid: the general assistant pinned first, then every catalog
// chat agent from the roster (name/description verbatim — the operator
// curates agents.json). An empty catalog means NO grid: the fallback layout
// keeps prompts + recent sessions only (the general agent is the implicit
// default there, no card needed).
export function showcaseCards(agents: AgentInfo[]): ShowcaseCard[] {
  const catalog = agents.filter((a) => a.id !== "local");
  if (catalog.length === 0) return [];
  return [
    { id: "local", name: "通用助手", description: GENERAL_DESCRIPTION, general: true },
    ...catalog.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      description: a.description || "",
      general: false,
    })),
  ];
}

// The recent-sessions strip: newest first (the server list already is), the
// CURRENT session excluded (on the welcome it is empty by definition), top 3.
export function recentStrip(sessions: SessionMeta[], currentId: string | null | undefined): SessionMeta[] {
  return sessions.filter((s) => s.id !== currentId).slice(0, 3);
}

// MP-density relative time for the strip; blank when unknown.
export function relativeTime(ts?: string | number): string {
  if (ts === undefined || ts === null || ts === "") return "";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
