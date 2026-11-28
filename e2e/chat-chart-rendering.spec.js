import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// A fenced ```echarts block in assistant output renders as a live chart; every
// other language keeps rendering as a code block. The React chat exposes its
// store on `window.__chatStore` in the e2e build, so the assistant text is
// pushed straight into the reducer instead of spending a real LLM turn.

const BAR = JSON.stringify({
  xAxis: { type: "category", data: ["a", "b", "c"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2, 3] }],
});

async function injectAssistantText(page, text) {
  await page.evaluate((t) => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "text", delta: t });
    s.apply({ type: "done" });
  }, text);
}

test.describe("chart rendering", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("an echarts fence renders a chart instead of code", async ({ page }) => {
    await injectAssistantText(page, "```echarts\n" + BAR + "\n```");
    const chart = page.getByTestId("echart");
    await expect(chart).toBeVisible();
    // ECharts paints a canvas into the container once loaded.
    await expect(chart.locator("canvas")).toHaveCount(1, { timeout: 20000 });
    // The fence is not also rendered as a code block.
    await expect(page.locator("pre")).toHaveCount(0);
  });

  test("a chart re-lays out when the container resizes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await injectAssistantText(page, "```echarts\n" + BAR + "\n```");
    const chart = page.getByTestId("echart");
    await expect(chart.locator("canvas")).toHaveCount(1, { timeout: 20000 });
    const wide = await chart.locator("canvas").evaluate((c) => c.width);

    await page.setViewportSize({ width: 640, height: 900 });
    await expect
      .poll(() => chart.locator("canvas").evaluate((c) => c.width))
      .toBeLessThan(wide);
  });

  test("switching theme re-creates the chart", async ({ page }) => {
    await injectAssistantText(page, "```echarts\n" + BAR + "\n```");
    const canvas = page.getByTestId("echart").locator("canvas");
    await expect(canvas).toHaveCount(1, { timeout: 20000 });
    // ECharts cannot re-theme in place, so the component disposes and re-inits;
    // a marker on the old canvas element proves a new one replaced it.
    await canvas.evaluate((c) => {
      c.__mark = 1;
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await expect.poll(() => canvas.evaluate((c) => c.__mark)).toBeUndefined();
  });

  test("the chart library is fetched only once a chart appears", async ({ page }) => {
    const scripts = new Set();
    page.on("request", (r) => {
      if (r.resourceType() === "script") scripts.add(r.url());
    });
    await injectAssistantText(page, "just prose, no chart");
    await page.waitForTimeout(400);
    const beforeChart = scripts.size;

    await injectAssistantText(page, "```echarts\n" + BAR + "\n```");
    await expect(page.getByTestId("echart").locator("canvas")).toHaveCount(1, { timeout: 20000 });
    // If the library were in the base bundle this would add no new script.
    expect(scripts.size).toBeGreaterThan(beforeChart);
  });

  test("a partial fence upgrades to a chart as it completes", async ({ page }) => {
    await page.evaluate((t) => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "text", delta: t });
    }, "```echarts\n" + BAR.slice(0, 20));
    await expect(page.getByTestId("echart")).toHaveCount(0);
    await expect(page.locator("pre")).toContainText("xAxis");

    await page.evaluate((t) => {
      const s = window.__chatStore.getState();
      s.apply({ type: "text", delta: t });
      s.apply({ type: "done" });
    }, BAR.slice(20) + "\n```");
    await expect(page.getByTestId("echart").locator("canvas")).toHaveCount(1, { timeout: 20000 });
  });

  test("a non-echarts fence still renders as a code block", async ({ page }) => {
    await injectAssistantText(page, '```json\n{"a":1}\n```');
    await expect(page.getByTestId("echart")).toHaveCount(0);
    await expect(page.locator("pre")).toContainText('{"a":1}');
  });

  test("a malformed echarts fence falls back to a code block", async ({ page }) => {
    await injectAssistantText(page, '```echarts\n{ "xAxis": "category", oops\n```');
    await expect(page.getByTestId("echart")).toHaveCount(0);
    await expect(page.locator("pre")).toContainText("xAxis");
  });

  test("a tooltip formatter cannot inject markup", async ({ page }) => {
    const payload = '<img src=x onerror="window.__xss=1">';
    const option = JSON.stringify({
      xAxis: { type: "category", data: ["a", "b"] },
      yAxis: { type: "value" },
      tooltip: { formatter: payload },
      series: [{ type: "bar", data: [1, 2] }],
    });
    await injectAssistantText(page, "```echarts\n" + option + "\n```");
    const chart = page.getByTestId("echart");
    await expect(chart.locator("canvas")).toHaveCount(1, { timeout: 20000 });

    // Hover the plot so a tooltip would render, then assert the formatter never
    // reached the DOM as live markup.
    const box = await chart.boundingBox();
    for (const fx of [0.4, 0.5, 0.6]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.7);
    }
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.body.innerHTML.includes("onerror"))).toBe(false);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});
