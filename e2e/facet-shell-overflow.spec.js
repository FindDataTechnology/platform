// Width budget of the shell (overhaul-facet-shell-ia-and-space D1/D2).
//
// The complaint that started that change was space: either wasted (content
// pinned to a narrow centred column with ~550px empty on each side) or spent
// badly (a list stretching one line of text across 1600px). The fix moved the
// width decision into one container contract — but width is also the first
// thing a longer label breaks, and the shell's labels are now task names in
// five languages (es "Estudio de creación" and ja "作成スタジオ" are both wider
// than the old "Studio"). A locale that pushes the tab row past the viewport
// turns the whole page into a horizontally scrolling document.
//
// The pre-existing sentinel covers #/packs at 375px in zh-CN only. This spec is
// the matrix: every locale × every built-in view × the widths around the rail's
// fold (1024px is the lg breakpoint) plus both ends of the range.
import { expect, test } from "@playwright/test";

const base = `http://127.0.0.1:${process.env.E2E_FACET_SHELL_PORT || 3209}`;
const LOCALES = ["en", "zh-CN", "es", "fr", "ja"];
/** Built-in views and the anchor that proves the view (not its skeleton) is up. */
const VIEWS = [
  ["#/", "intro-cta-packs", "intro"],
  ["#/packs", "pack-search-input", "packs"],
  ["#/mcp", "mcp-catalog", "mcp"],
  ["#/docs", "docs-install", "docs"],
];
const WIDTHS = [1920, 1280, 1024, 900, 768, 390];

/** Page-level horizontal scroll, plus the leaf offenders — an element that
 *  sticks past the viewport with no clipping ancestor and no child that also
 *  sticks out. Reporting the widest boxes instead names elements whose parent
 *  already clips them (the real overflow is often a few px from a long word). */
const widthReport = (page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const all = [...document.querySelectorAll("body *")];
    const rects = new Map(all.map((el) => [el, el.getBoundingClientRect()]));
    const clipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") return true;
      }
      return false;
    };
    const over = all
      .filter((el) => rects.get(el).right > limit + 1 && !clipped(el))
      .filter((el) => ![...el.children].some((c) => (rects.get(c)?.right ?? 0) > limit + 1))
      .map((el) => {
        const r = rects.get(el);
        return {
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute("data-testid") || "",
          cls: String(el.className || "").slice(0, 120),
          text: (el.textContent || "").trim().slice(0, 40),
          x: Math.round(r.x),
          right: Math.round(r.right),
          width: Math.round(r.width),
        };
      })
      .slice(0, 5);
    return { scroll: doc.scrollWidth, client: limit, over };
  });

test("no view overflows horizontally in any locale at any width", async ({ browser }) => {
  test.setTimeout(180_000);
  for (const locale of LOCALES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    // The shell reads its locale store at boot (same key the 壹座 suite uses),
    // so one context per locale and a fresh document per view is the honest
    // measurement — no in-page locale switching artefacts.
    await page.addInitScript((l) => localStorage.setItem("platform.locale", l), locale);
    try {
      for (const [hash, anchor, name] of VIEWS) {
        await page.setViewportSize({ width: WIDTHS[0], height: 900 });
        await page.goto(`${base}/${hash}`);
        await expect(page.getByTestId("facet-tabs")).toBeVisible();
        await expect(page.getByTestId(anchor)).toBeVisible();
        // Structural half of the same contract (facet-platform: every view on
        // ONE shared container grid). Measuring content width alone can pass
        // for a bare view that happens to look narrow; asserting that the view
        // sits INSIDE a container is the property, not a sample of it. Scoped
        // to the view's own anchor: the intro also carries the footer's
        // containers, so an unscoped lookup is ambiguous.
        await expect(page.locator(`[data-testid="facet-container"] [data-testid="${anchor}"]`)).toBeVisible();
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          const report = await widthReport(page);
          expect(
            { scroll: report.scroll, client: report.client },
            `${locale} ${name} @${width}px scrolls horizontally ` +
              `(scrollWidth ${report.scroll} > ${report.client}); ` +
              `offenders: ${JSON.stringify(report.over)}`,
          ).toEqual({ scroll: report.client, client: report.client });
        }
      }
    } finally {
      await context.close();
    }
  }
});
