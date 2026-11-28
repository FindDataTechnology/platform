// ── MCP 服务器深度视图（polish-facet-mcp-surface D6）─────────────────────────
//
// 本文件原为 McpCatalog.tsx，其中还带着一个早已无人挂载的目录外壳（标签页 +
// 服务器列表 + 技能列表）。该外壳连同它的文案已整份删除：同一个物种不该有
// 第二个浏览面。留下的是目录页真正在用的深度视图。

import { useEffect, useState } from "react";
import { Badge } from "@/components/packs/Badge";
import { useLanguage } from "@/i18n/useLanguage";
import { useTranslation } from "react-i18next";
import { descriptionExceedsPreview, filterTools, groupAnchorId, groupToolsByPrefix, jumpTargets } from "./mcpDepthTools";

// Supply annotation (add-mcp-annotation-overlay): projected server-side to the
// request locale (zh 唯一回落); absent for unannotated entries — raw rendering.
type SupplyAnnotation = {
  name: string | null;
  summary: string | null;
  whenToUse: string | null;
  source: string | null;
};

type McpDepth = {
  name: string;
  displayName: string;
  description: string;
  endpoint: string;
  requiredGroups: string[];
  annotation?: SupplyAnnotation;
  tools: { name: string; description: string; annotation?: SupplyAnnotation }[] | null;
  toolCount: number | null;
  license: string | null;
  providerOrganization: string | null;
  deployment: string | null;
  tags: string[];
};

/** 加载骨架（深度视图取数期间）。 */
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

/** 导出给目录页复用（unify-material-catalog-page 1.3）：深度视图不重写，
 *  否则两处会漂移成两种工具面呈现。 */
export function ServerDepth({
  name,
  onBack,
  initialQuery = "",
}: {
  name: string;
  onBack: () => void;
  /** 跨服务检索落点（polish-facet-mcp-surface 3.2）：命中的工具名预填进过滤框，
   *  让读者一进来就看见那个工具，而不是进来再自己搜一遍。 */
  initialQuery?: string;
}) {
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
            <ToolSurface tools={doc.tools} initialQuery={initialQuery} />
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
function ToolSurface({
  tools,
  initialQuery = "",
}: {
  tools: NonNullable<McpDepth["tools"]>;
  initialQuery?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = filterTools(tools, query);
  const groups = groupToolsByPrefix(filtered);
  // Jump navigation derived from the SAME filtered groups the list renders
  // (D3): a filter that empties a group also drops its anchor.
  const jumps = jumpTargets(groups);

  return (
    <div className="space-y-4" data-testid="mcp-depth-tools-list">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("mcp.depth.filterPlaceholder")}
        data-testid="mcp-depth-tools-filter"
        className="w-full sm:max-w-md px-3 py-2 rounded-lg border border-border bg-background text-sm"
      />
      {jumps.length > 0 && (
        <nav className="flex flex-wrap gap-1.5" data-testid="mcp-depth-jump" aria-label={t("mcp.depth.jumpLabel")}>
          {jumps.map((j) => (
            <a
              key={j.anchorId}
              href={`#${j.anchorId}`}
              data-testid={`mcp-depth-jump-${j.prefix ?? "other"}`}
              // In-page anchor only: the hash is owned by the shell's routing,
              // so this scrolls without rewriting location.hash.
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(j.anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {j.prefix ?? t("mcp.depth.groupOther")}
              <span className="ml-1 tabular-nums opacity-70">{j.count}</span>
            </a>
          ))}
        </nav>
      )}
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="mcp-depth-tools-empty">{t("mcp.depth.noResults")}</p>
      ) : (
        groups.map((group) => (
          <section
            key={group.prefix ?? "__other__"}
            id={groupAnchorId(group.prefix)}
            data-testid={`mcp-tool-group-${group.prefix ?? "other"}`}
            className="scroll-mt-4"
          >
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
