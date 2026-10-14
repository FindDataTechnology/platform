// EChart — renders an ECharts option object. Used by the markdown renderer for
// ```echarts fences; not wired to any other surface.
//
// Lazy: echarts core + only the registered chart/component modules load on the
// first chart, mirroring the shiki lazy singleton in Markdown.tsx, so a
// chart-free transcript never downloads the library.
//
// SAFETY: the option is model output treated as data. ECharts tooltips render
// their formatter as rich HTML, which is the same surface rehype-raw was left
// off to avoid, so tooltip formatter/extraCssText are stripped before setOption.

import { memo, useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import { useTheme, type Theme } from "@/hooks/useTheme";

type EchartsCore = typeof import("echarts/core");

let echartsPromise: Promise<EchartsCore> | null = null;
function getEcharts(): Promise<EchartsCore> {
  if (!echartsPromise) {
    echartsPromise = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import("echarts/core"),
        import("echarts/charts"),
        import("echarts/components"),
        import("echarts/renderers"),
      ]);
      core.use([
        charts.BarChart,
        charts.LineChart,
        charts.PieChart,
        charts.ScatterChart,
        components.GridComponent,
        components.TooltipComponent,
        components.LegendComponent,
        components.TitleComponent,
        components.DatasetComponent,
        components.MarkLineComponent,
        components.MarkPointComponent,
        renderers.CanvasRenderer,
      ]);
      return core;
    })();
  }
  return echartsPromise;
}

// ECharts cannot re-theme an existing instance, so a theme switch disposes and
// re-inits. Light uses the stock palette; dark overrides only what would be
// unreadable on the app's near-black surfaces.
function axisStyle() {
  return {
    axisLine: { lineStyle: { color: "#4b5563" } },
    axisTick: { lineStyle: { color: "#4b5563" } },
    axisLabel: { color: "#9ca3af" },
    nameTextStyle: { color: "#9ca3af" },
    splitLine: { lineStyle: { color: "#374151" } },
  };
}
const DARK_THEME = {
  backgroundColor: "transparent",
  textStyle: { color: "#c9d1d9" },
  title: { textStyle: { color: "#c9d1d9" } },
  legend: { textStyle: { color: "#c9d1d9" } },
  categoryAxis: axisStyle(),
  valueAxis: axisStyle(),
  logAxis: axisStyle(),
  timeAxis: axisStyle(),
  tooltip: {
    backgroundColor: "#1f2937",
    borderColor: "#374151",
    textStyle: { color: "#e5e7eb" },
  },
};

// Strip any option field ECharts would render as HTML. tooltip objects appear
// at the top level and per series, so walk the whole tree.
function sanitize(node: unknown): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "tooltip" && value && typeof value === "object") {
      const tooltip = value as Record<string, unknown>;
      delete tooltip.formatter;
      delete tooltip.extraCssText;
    }
    sanitize(value);
  }
}

// The active theme resolves to a concrete light/dark: an explicit choice is the
// theme itself, "system" follows the OS media query.
function useResolvedDark(theme: Theme): boolean {
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return theme === "dark" || (theme === "system" && systemDark);
}

export const EChart = memo(function EChart({ option }: { option: object }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<EChartsType | null>(null);
  const dark = useResolvedDark(useTheme().theme);

  useEffect(() => {
    let disposed = false;
    let instance: EChartsType | null = null;
    (async () => {
      const core = await getEcharts();
      if (disposed || !containerRef.current) return;
      instance = core.init(containerRef.current, dark ? DARK_THEME : undefined);
      setChart(instance);
    })();
    return () => {
      disposed = true;
      instance?.dispose();
      setChart(null);
    };
  }, [dark]);

  useEffect(() => {
    if (!chart) return;
    const safe = structuredClone(option);
    sanitize(safe);
    chart.setOption(safe as never, { notMerge: true });
  }, [chart, option]);

  useEffect(() => {
    if (!chart || !containerRef.current) return;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [chart]);

  return (
    <div
      data-testid="echart"
      ref={containerRef}
      className="my-3 h-80 w-full overflow-hidden rounded-md border border-border bg-card p-2"
    />
  );
});
