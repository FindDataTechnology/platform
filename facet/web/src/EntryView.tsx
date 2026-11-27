// ── 入口页（merge-plaza-into-facet-entry 3.2）────────────────────────────────
//
// `facet.finddatatech.cloud/#/` 的落地视图。它把两个面的叙事合成一条流：
//
//   素材有什么 → 素材目录（live 画廊）→ 怎么供给 → 团队模板 → 创作路径 → 给谁用
//
// 顺序是产品裁定（2026-11-21）：**素材为主、产品叙事为辅**。素材广场首先回答
// 「这里有什么」，然后才回答「这个产品能干什么」。旧的两个面各讲一半，用户得
// 在两个地址之间跳；现在一条读完。
//
// 叙事段全静态；动态区有两处（surface-material-previews D5 起）：
//   ① 素材目录入口段：至多 3 条真实缩略（跨物种混编），取数失败退回灰底 chip；
//   ② ProductIntroSection 里的画廊（live 优先、快照回落、as-of 永远可见）。
// 两者共存是刻意的：`facet-platform` 的原「fully static」约束先是收窄为
// 「叙事静态、画廊是唯一的动态区」，本次再收窄为「叙事静态；目录入口段可带
// 至多 3 条 live 缩略」。**上限是硬约束**——入口页高度不得随库存增长，
// 142 条与 10 条库存必须逐像素同高（spec: The entry page's height is bounded）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Container } from "./Container";
import { ProductIntroSection } from "./EntrySections";
import { resolvePreviewRow, type PreviewRow } from "./catalog-model";

const SPECIES = ["pack", "skill", "mcp", "facade", "data-anchor"] as const;

/** counts.json 里每物种 ≤3 条预览（导出器 buildPreview 产出）。 */
/** 入口段混编后固定 3 条——与库存规模无关。 */
const ENTRY_PREVIEW_COUNT = 3;

/** 跨物种各取第一条，轮转凑满 n 条；某一物种没有就跳过，绝不补占位。 */
function mixPreview(preview: Record<string, PreviewRow[]> | null, n: number): { species: string; row: PreviewRow }[] {
  if (!preview) return [];
  const queues = SPECIES.map((s) => ({ species: s, rows: [...(preview[s] ?? [])] })).filter((q) => q.rows.length > 0);
  const out: { species: string; row: PreviewRow }[] = [];
  let round = 0;
  while (out.length < n && queues.some((q) => q.rows.length > round)) {
    for (const q of queues) {
      if (out.length >= n) break;
      const row = q.rows[round];
      if (row) out.push({ species: q.species, row });
    }
    round += 1;
  }
  return out;
}

export function EntryView({ signedIn = false }: { signedIn?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language ?? "zh-CN";
  // null = 还没拿到（渲染灰底 chip，与取数失败同形——两者都不该出现的
  // 「加载中」态在入口页没有价值，读者看到的总是确定的东西）。
  const [preview, setPreview] = useState<Record<string, PreviewRow[]> | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/generated/counts.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.preview) return;
        setPreview(d.preview as Record<string, PreviewRow[]>);
      })
      // 取不到就保持 null → 灰底 chip 形态。不报错、不空转。
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const mixed = mixPreview(preview, ENTRY_PREVIEW_COUNT).map(({ species, row }) => ({
    species,
    row: resolvePreviewRow(row, locale),
  }));

  return (
    <Container>
      <div className="space-y-6">
        {/* 0. Hero —— 旧 agent. 静态站的主标语。2026-11-21 用户指出「找不到以前的
            agent 介绍页」：迁移时漏了 hero 这一组键，四段都在而主标语没了。
            标题里的 <br> 已去掉，由容器宽度决定折行。 */}
        <section data-testid="entry-hero">
          <h1 className="text-2xl font-semibold tracking-tight">{t("entryPlaza.hero.title")}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("entryPlaza.hero.lead")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t("entryPlaza.hero.actions")}</p>
        </section>

        {/* 1. 素材有什么 */}
        <section className="rounded-lg border border-border p-6" data-testid="entry-materials">
          <h2 className="text-lg font-semibold">{t("entryPlaza.materials.title")}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("entryPlaza.materials.lead")}
          </p>
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {SPECIES.map((s) => (
              <div key={s} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <dt className="text-sm font-medium">{t(`entryPlaza.materials.species.${s}.title`)}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(`entryPlaza.materials.species.${s}.body`)}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* 2. 素材目录入口 —— **不嵌列表**（unify-material-catalog-page 3.1）。
               2026-11-22 实测：入口页曾嵌 822 张卡、单块 30,352px，页面 32,600px
               （40 个视口），「怎么供给」「给谁用」落在 31,000px 外，没人滚得到。
               这里只报计数 + 入口，列表在 #/catalog。 */}
        <section className="rounded-lg border border-border p-6" data-testid="entry-catalog-entry">
          <h2 className="text-lg font-semibold">{t("entryPlaza.catalogEntry.title")}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("entryPlaza.catalogEntry.lead")}
          </p>
          {/* 预览区（surface-material-previews D5/D6）：有数据 → 3 张真实缩略卡；
              取不到或无数据 → 退回灰底物种 chip（今天的形态）。两种形态都只占
              固定高度，不随库存变化。 */}
          {mixed.length > 0 ? (
            <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="entry-catalog-preview">
              {mixed.map(({ species, row }) => (
                <li key={`${species}-${row.name}`}>
                  <a
                    href={`#/catalog?species=${species}`}
                    className="block h-full rounded-md border border-border bg-muted/30 px-3 py-2 transition-colors hover:border-primary/50"
                    data-testid={`entry-preview-${species}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
                      <span className="shrink-0 text-[10px] font-mono text-muted-foreground">
                        {t(`entryPlaza.materials.species.${species}.title`, species)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{row.blurb}</p>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3" data-testid="entry-catalog-species-chips">
              {SPECIES.map((s) => (
                <span
                  key={s}
                  className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                >
                  {t(`entryPlaza.materials.species.${s}.title`, s)}
                </span>
              ))}
            </div>
          )}
          <a
            href="#/catalog"
            className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
            data-testid="entry-catalog-link"
          >
            {t("entryPlaza.catalogEntry.cta")} →
          </a>
        </section>

        {/* 3. 怎么供给 */}
        <section className="rounded-lg border border-border p-6" data-testid="entry-mechanism">
          <h2 className="text-lg font-semibold">{t("entryPlaza.mechanism.title")}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("entryPlaza.mechanism.lead")}
          </p>
          <ol className="mt-4 space-y-2">
            {(["publish", "obtain", "run", "serve"] as const).map((seg, i) => (
              <li key={seg} className="flex gap-3 text-sm">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                <span>
                  <span className="font-medium">{t(`entryPlaza.mechanism.${seg}.title`)}</span>
                  <span className="text-muted-foreground"> — {t(`entryPlaza.mechanism.${seg}.body`)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* 4. 产品介绍（hero / 快速开始 / 路径图 / 三卡片 / line 回链）——
            这些是 facet-platform spec 点名要求的内容，不能因为「入口页重排」
            就消失。以 section 形式复用旧组件，文案与 CLI 事实仍是单源。 */}
        <ProductIntroSection signedIn={signedIn} />

        {/* 团队模板与创作路径**不在这里单独渲染**：ProductIntroSection（原 IntroView）
            内部已经包含它们。2026-11-21 实撞——两处都调导致这四段各出现两次
            （浏览器实测 intro-team-templates / intro-creation-path 等 testid 重复）。
            入口页的职责只是排序，不复制内容。 */}

        {/* 6. 给谁用 */}
        <section className="rounded-lg border border-border p-6" data-testid="entry-audience">
          <h2 className="text-lg font-semibold">{t("entryPlaza.audience.title")}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("entryPlaza.audience.lead")}
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <p className="text-sm font-medium">{t("entryPlaza.audience.human.title")}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("entryPlaza.audience.human.body")}
              </p>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <p className="text-sm font-medium">{t("entryPlaza.audience.ai.title")}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("entryPlaza.audience.ai.body")}
              </p>
            </div>
          </div>
        </section>
      </div>
    </Container>
  );
}

export default EntryView;
