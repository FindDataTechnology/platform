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
// 叙事段全静态；画廊是唯一动态区（live 优先、快照回落、as-of 永远可见）。
// 两者共存是刻意的：`facet-platform` 的原「fully static」约束在本次改为
// 「叙事静态、画廊是唯一的动态区」，因为画廊的降级语义比那条约束更成熟。
import { useTranslation } from "react-i18next";
import { Container } from "./Container";
import { MaterialGallery } from "./MaterialGallery";
import { ProductIntroSection } from "./EntrySections";

const SPECIES = ["pack", "skill", "mcp", "facade", "official-data"] as const;

export function EntryView({ signedIn = false }: { signedIn?: boolean } = {}) {
  const { t } = useTranslation();

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
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

        {/* 2. 素材目录（唯一的动态区） */}
        <MaterialGallery />

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
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
