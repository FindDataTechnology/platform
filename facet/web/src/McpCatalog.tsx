// MCP 服务目录 (add-facet-platform S2; depth view + skills catalog added by
// add-facet-infra-pages): 注册处 MCP 卡片 + 按需深度视图（工具面/来源许可
// 证/档位）+ skills 目录（来源与许可证标注，ecosystem-curation 的可见面兑
// 现）。全部只读；无字段如实标注「未标注/未捕获」，绝不编造。

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/packs/Badge";
import { useLanguage } from "@/i18n/useLanguage";
import { useTranslation } from "react-i18next";
import { descriptionExceedsPreview, filterTools, groupToolsByPrefix } from "./mcpDepthTools";

// Supply annotation (add-mcp-annotation-overlay): projected server-side to the
// request locale (zh 唯一回落); absent for unannotated entries — raw rendering.
type SupplyAnnotation = {
  name: string | null;
  summary: string | null;
  whenToUse: string | null;
  source: string | null;
};

type McpCard = {
  name: string;
  displayName: string;
  description: string;
  endpoint: string;
  requiredGroups: string[];
  annotation?: SupplyAnnotation;
};

type McpDepth = McpCard & {
  tools: { name: string; description: string; annotation?: SupplyAnnotation }[] | null;
  toolCount: number | null;
  license: string | null;
  providerOrganization: string | null;
  deployment: string | null;
  tags: string[];
};

type SkillRow = {
  name: string;
  displayName: string;
  description: string;
  annotation?: SupplyAnnotation;
  repositoryUrl: string | null;
  author: string | null;
  version: string | null;
  tags: string[];
};

const SKILL_PAGE_SIZE = 24;

export function McpCatalog() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"servers" | "skills">("servers");

  return (
    <div className="space-y-4" data-testid="mcp-catalog">
      {/* 平台基建 vs 包内容 (add-facet-infra-pages 4.1): 讲清两者关系与装法差异。 */}
      <section className="rounded-lg border border-border bg-muted/30 p-4 text-sm" data-testid="infra-narrative">
        <h2 className="font-semibold mb-1">{t("mcp.narrative.title")}</h2>
        <p className="text-muted-foreground leading-6">{t("mcp.narrative.body")}</p>
      </section>

      <div className="flex gap-2" data-testid="mcp-tabs">
        {(["servers", "skills"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`mcp-tab-${id}`}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              tab === id ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(id === "servers" ? "mcp.tabs.servers" : "mcp.tabs.skills")}
          </button>
        ))}
      </div>

      {tab === "servers" ? <ServersSection /> : <SkillsSection />}
    </div>
  );
}

function ServersSection() {
  const { t } = useTranslation();
  // polish-facet-catalog-depth: the data face follows the surface's own locale
  // selection (not merely Accept-Language); a switch refetches via deps.
  const { locale } = useLanguage();
  const [cards, setCards] = useState<McpCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/mcp-catalog?locale=${locale}`)
      .then((r) => r.json())
      .then((d) => setCards(Array.isArray(d?.servers) ? d.servers : []))
      .catch((e) => setError(String(e)));
  }, [locale]);

  if (selected) return <ServerDepth name={selected} onBack={() => setSelected(null)} />;

  if (error)
    return (
      <div className="text-sm text-muted-foreground space-y-2" data-testid="mcp-error">
        <p>{t("mcp.unavailable", { error })}</p>
        <button type="button" className="text-sm text-primary hover:underline" onClick={() => location.reload()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!cards) return <CardsSkeleton />;
  if (cards.length === 0)
    return <div className="text-sm text-muted-foreground" data-testid="mcp-empty">{t("mcp.empty")}</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("mcp.intro")}</p>
      {cards.map((c) => (
        <button
          key={c.name}
          type="button"
          onClick={() => setSelected(c.name)}
          data-testid={`mcp-card-${c.name}`}
          className="w-full text-left border border-border rounded-lg p-4 hover:bg-muted/40 transition-colors"
        >
          <div className="flex items-center justify-between">
            {/* add-mcp-annotation-overlay: the localized human name leads when
                present; the raw displayName stays in the depth view. */}
            <span className="font-medium">{c.annotation?.name || c.displayName}</span>
            {c.requiredGroups.length > 0 && <Badge>{t("mcp.requiresGroup", { group: c.requiredGroups[0] })}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{c.annotation?.summary || c.description}</p>
          <code className="text-xs text-muted-foreground mt-2 block break-all">{c.endpoint}</code>
        </button>
      ))}
    </div>
  );
}

/** Card-list skeleton: three card shells matching the loaded rows (polish-facet-usability state contract). */
function CardsSkeleton() {
  return (
    <div className="space-y-3" data-testid="mcp-cards-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4 space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-56 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ServerDepth({ name, onBack }: { name: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { locale } = useLanguage();
  const [doc, setDoc] = useState<McpDepth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/mcp-catalog/${encodeURIComponent(name)}?locale=${locale}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDoc)
      .catch((e) => setError((e as Error).message));
  }, [name, locale]);

  // Width belongs to the shell's container (DESIGN.md §8): this view used to
  // cap itself at max-w-6xl and centre, which made it a third width on a screen
  // where every sibling view sits on one grid.
  return (
    <div className="space-y-4" data-testid={`mcp-depth-${name}`}>
      <button type="button" onClick={onBack} className="text-sm text-primary hover:underline" data-testid="mcp-depth-back">
        ← {t("mcp.depth.back")}
      </button>
      {error && <div className="text-sm text-muted-foreground">{t("mcp.depth.failed", { message: error })}</div>}
      {!error && !doc && <CardsSkeleton />}
      {doc && (
        <>
          <header>
            <h2 className="text-lg font-semibold">{doc.annotation?.name || doc.displayName}</h2>
            <p className="text-sm text-muted-foreground mt-1">{doc.annotation?.summary || doc.description}</p>
          </header>

          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid="mcp-depth-facts">
            <dt className="text-muted-foreground">{t("mcp.depth.endpoint")}</dt>
            <dd><code className="text-xs break-all">{doc.endpoint}</code></dd>
            <dt className="text-muted-foreground">{t("mcp.depth.license")}</dt>
            <dd data-testid="mcp-depth-license">{doc.license ?? t("mcp.depth.notDeclared")}</dd>
            <dt className="text-muted-foreground">{t("mcp.depth.provider")}</dt>
            <dd data-testid="mcp-depth-provider">{doc.providerOrganization ?? t("mcp.depth.notDeclared")}</dd>
            <dt className="text-muted-foreground">{t("mcp.depth.tier")}</dt>
            <dd>{doc.deployment ?? t("mcp.depth.notDeclared")}</dd>
            <dt className="text-muted-foreground">{t("mcp.depth.groups")}</dt>
            <dd>{doc.requiredGroups.length > 0 ? doc.requiredGroups.join("、") : t("mcp.depth.public")}</dd>
          </dl>

          {doc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {doc.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}

          <section data-testid="mcp-depth-tools">
            <h3 className="font-medium mb-2">
              {t("mcp.depth.tools")}
              {doc.toolCount != null && <span className="ml-2 text-xs text-muted-foreground">{t("mcp.depth.toolCount", { count: doc.toolCount })}</span>}
            </h3>
          {doc.tools === null ? (
            <p className="text-sm text-muted-foreground" data-testid="mcp-depth-tools-missing">{t("mcp.depth.toolsMissing")}</p>
          ) : (
            <ToolSurface tools={doc.tools} />
          )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Depth-view tool surface (polish-facet-catalog-depth 2.x): prefix grouping +
 * client-side filter + responsive multi-column grid + clamp-to-preview
 * descriptions. Scanability governs density (impeccable Operate): the raw
 * callable name always stays visible (never replaced — spec contract), the
 * localized human label and summary lead when present.
 */
function ToolSurface({ tools }: { tools: NonNullable<McpDepth["tools"]> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = filterTools(tools, query);
  const groups = groupToolsByPrefix(filtered);

  return (
    <div className="space-y-4" data-testid="mcp-depth-tools-list">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("mcp.depth.filterPlaceholder")}
        data-testid="mcp-depth-tools-filter"
        className="w-full sm:max-w-md px-3 py-2 rounded-lg border border-border bg-background text-sm"
      />
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="mcp-depth-tools-empty">{t("mcp.depth.noResults")}</p>
      ) : (
        groups.map((group) => (
          <section key={group.prefix ?? "__other__"} data-testid={`mcp-tool-group-${group.prefix ?? "other"}`}>
            <h4 className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground mb-2">
              <span>{group.prefix ?? t("mcp.depth.groupOther")}</span>
              <span className="tabular-nums">{group.tools.length}</span>
            </h4>
            {/* 对齐技能区既有范式（sm:grid-cols-2），xl 下三列扫读。 */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.tools.map((tool) => {
                // 注释 summary 优先、原文兜底（design D2）——clamp 作用于
                // 这一段展示文本；无注释工具原文渲染逐字节不变。
                const summary = tool.annotation?.summary ?? "";
                const text = summary || tool.description;
                const over = !!text && descriptionExceedsPreview(text);
                const open = !!expanded[tool.name];
                return (
                  <div key={tool.name} className="border border-border rounded-md p-3 flex flex-col" data-testid={`mcp-tool-${tool.name}`}>
                    {/* add-mcp-annotation-overlay: the human label leads, the
                        raw callable name stays visible (never replaced). */}
                    <div className="flex items-baseline gap-2 flex-wrap">
                      {tool.annotation?.name && <span className="text-xs font-medium text-foreground">{tool.annotation.name}</span>}
                      <span className="font-mono text-xs text-muted-foreground break-all">{tool.name}</span>
                    </div>
                    {text && (
                      <p
                        data-testid={`mcp-tool-summary-${tool.name}`}
                        className={`text-xs mt-1 leading-5 whitespace-pre-wrap ${summary ? "text-foreground" : "text-muted-foreground"} ${over && !open ? "line-clamp-4" : ""}`}
                      >
                        {text}
                      </p>
                    )}
                    {over && (
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [tool.name]: !prev[tool.name] }))}
                        data-testid={`mcp-tool-toggle-${tool.name}`}
                        className="text-xs text-primary hover:underline mt-1 self-start"
                      >
                        {open ? t("mcp.depth.collapse") : t("mcp.depth.expand")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function SkillsSection() {
  const { t } = useTranslation();
  const { locale } = useLanguage();
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetch(`/api/skills-catalog?locale=${locale}`)
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d?.skills) ? d.skills : []))
      .catch((e) => setError(String(e)));
  }, [locale]);

  const filter = useCallback(
    (list: SkillRow[]) => {
      const needle = q.trim().toLowerCase();
      if (!needle) return list;
      return list.filter((s) =>
        [s.name, s.description, s.author ?? "", ...(s.tags ?? [])].join(" ").toLowerCase().includes(needle),
      );
    },
    [q],
  );

  if (error)
    return (
      <div className="text-sm text-muted-foreground space-y-2" data-testid="skills-error">
        <p>{t("mcp.unavailable", { error })}</p>
        <button type="button" className="text-sm text-primary hover:underline" onClick={() => location.reload()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!rows) return <CardsSkeleton />;
  if (rows.length === 0)
    return <div className="text-sm text-muted-foreground" data-testid="skills-empty">{t("mcp.skills.empty")}</div>;

  const filtered = filter(rows);
  const pages = Math.max(1, Math.ceil(filtered.length / SKILL_PAGE_SIZE));
  const current = Math.min(page, pages);
  const slice = filtered.slice((current - 1) * SKILL_PAGE_SIZE, current * SKILL_PAGE_SIZE);

  return (
    <div className="space-y-3" data-testid="skills-catalog">
      <div className="flex items-center gap-3">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder={t("mcp.skills.search")}
          data-testid="skills-search"
          className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm"
        />
        <span className="text-sm text-muted-foreground">{t("mcp.skills.count", { count: filtered.length })}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {slice.map((s) => (
          <div key={s.name} className="border border-border rounded-lg p-4 space-y-1.5" data-testid={`skill-card-${s.name}`}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{s.annotation?.name || s.displayName}</span>
              {s.version && <span className="text-xs text-muted-foreground">v{s.version}</span>}
            </div>
            <p className="text-sm text-muted-foreground">{s.annotation?.summary || s.description || t("mcp.skills.noDescription")}</p>
            <div className="text-xs text-muted-foreground space-y-0.5" data-testid={`skill-provenance-${s.name}`}>
              <div>
                {t("mcp.skills.source")}：{s.repositoryUrl
                  ? <a href={s.repositoryUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">{s.repositoryUrl}</a>
                  : t("mcp.depth.notDeclared")}
              </div>
              <div>
                {t("mcp.skills.author")}：{s.author ?? t("mcp.depth.notDeclared")}
              </div>
            </div>
            {s.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {s.tags.slice(0, 6).map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            disabled={current <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-3 py-1.5 rounded-md border border-border disabled:opacity-40"
          >
            {t("mcp.skills.prev")}
          </button>
          <span className="text-muted-foreground">{t("mcp.skills.page", { page: current, pages })}</span>
          <button
            type="button"
            disabled={current >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1.5 rounded-md border border-border disabled:opacity-40"
          >
            {t("mcp.skills.next")}
          </button>
        </div>
      )}
    </div>
  );
}
