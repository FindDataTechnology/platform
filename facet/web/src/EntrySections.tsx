// ── 入口页的两段产品叙事（merge-plaza-into-facet-entry 3.1）──────────────────
//
// 从 IntroView.tsx 抽出来的两个 section，供「入口页」与旧的介绍视图共用。
// 抽出来不是为了整洁——入口页要把它们和素材叙事排在同一条流里，而同一个
// 组件被两处引用才不会让文案分叉。
//
// 两段都是**无条件渲染**的：团队模板那段不能因为"不是每个包都是团队"就消失
// （facet-platform spec: team templates are presented as a first-class use），
// 创作路径那段必须点名人的采用是唯一闸门，否则创作台会读成「AI 替你写完」。
import { useTranslation } from "react-i18next";

const TEAM_FACETS = ["roles", "cadence", "slots", "edges", "acceptance"] as const;
const CREATION_STAGES = ["stage1", "stage2", "stage3", "stage4"] as const;

export function TeamTemplatesSection() {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-border p-6" data-testid="intro-team-templates">
      <h2 className="text-lg font-semibold">{t("facetIntro.teamTemplates.title")}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {t("facetIntro.teamTemplates.body")}
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {TEAM_FACETS.map((f) => (
          <div key={f} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <dt className="text-sm font-medium">{t(`facetIntro.teamTemplates.facet.${f}.title`)}</dt>
            <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t(`facetIntro.teamTemplates.facet.${f}.body`)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function CreationPathSection({ signedIn = false }: { signedIn?: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-border p-6" data-testid="intro-creation-path">
      <h2 className="text-lg font-semibold">{t("facetIntro.creationPath.title")}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {t("facetIntro.creationPath.body")}
      </p>
      <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {CREATION_STAGES.map((s, i) => (
          <li key={s} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <span className="text-xs font-mono text-muted-foreground">{i + 1}</span>
            <p className="mt-1 text-sm font-medium">{t(`facetIntro.creationPath.${s}`)}</p>
          </li>
        ))}
      </ol>
      {/* The gate is the point: the model drafts, a human adopts. */}
      <p className="mt-3 text-xs text-muted-foreground" data-testid="intro-creation-gate">
        {t("facetIntro.creationPath.gate")}
      </p>
      {/* Visibility follows the CONFIRMED login state — the caller passes
          `signedIn` only once the identity probe has answered, so the entry
          never paints and then vanishes. Not a redirect: `#/` is the public
          front door and a signed-in visitor opening it should still see it. */}
      {signedIn && (
        <a
          href="#/studio"
          data-testid="intro-cta-studio"
          className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t("facetIntro.creationPath.cta")}
        </a>
      )}
    </section>
  );
}

// 产品介绍块（hero / 快速开始 / 路径图 / 三卡片 / line 回链）仍住在 IntroView.tsx：
// 它原本就是那个视图，内容一字未改，只是从「整页」降为「入口页的一段」。
export { ProductIntroSection } from "./IntroView";
