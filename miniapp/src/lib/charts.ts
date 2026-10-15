// Canvas chart rendering for `echarts` fences.
//
// A dependency-free renderer for the four registered series types the web
// client draws (bar / line / pie / scatter), using the mini program's legacy
// canvas API with page-level draw calls — the reliable path in custom
// component trees. Options are registered by the markdown renderer and drawn
// by the page after layout; a draw failure flips the entry to "failed" so
// the renderer falls back to the raw code block (the spec's contract).

import Taro from "@tarojs/taro";

export type ChartStatus = "pending" | "drawn" | "failed";

interface ChartEntry {
  option: Record<string, unknown>;
  status: ChartStatus;
}

const SERIES_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
const charts = new Map<string, ChartEntry>();
const listeners = new Set<() => void>();
let version = 0;

export function registerChart(id: string, option: Record<string, unknown>) {
  const existing = charts.get(id);
  if (existing) {
    // The same canvas can be handed NEW data: a refresh of a bound chart (the
    // resources page) and a streaming fence upgraded in place (the chat) both
    // re-register. Replace and mark pending, or the canvas keeps drawing the
    // old series forever; an unchanged option is left alone so an ordinary
    // re-render is not a redraw.
    if (JSON.stringify(existing.option) === JSON.stringify(option)) return;
    charts.set(id, { option, status: "pending" });
    return;
  }
  charts.set(id, { option, status: "pending" });
}

export function chartStatus(id: string): ChartStatus | undefined {
  return charts.get(id)?.status;
}

export function subscribeCharts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function chartsVersion(): number {
  return version;
}

function bump() {
  version++;
  for (const fn of listeners) fn();
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function drawAllCharts() {
  let pending = false;
  for (const [id, entry] of charts) {
    if (entry.status !== "pending") continue;
    pending = true;
    try {
      drawChart(id, entry.option);
      entry.status = "drawn";
    } catch {
      entry.status = "failed";
      bump();
    }
  }
  return pending;
}

function drawChart(canvasId: string, option: Record<string, unknown>) {
  const ctx = Taro.createCanvasContext(canvasId);
  const width = Math.max(320, Math.min(640, Taro.getSystemInfoSync().windowWidth - 48));
  const height = 220;
  const series = asArray<Record<string, unknown>>(option.series);
  const first = series[0];
  if (!first) throw new Error("no series");

  const type = String(first.type ?? "bar");
  if (type === "pie") {
    drawPie(ctx, first, width, height);
    return;
  }

  const xAxis = (option.xAxis ?? {}) as Record<string, unknown>;
  const categories = asArray<string | number>(xAxis.data);
  const pointCount = Math.max(
    categories.length,
    ...series.map((s) => asArray<unknown>(s.data).length),
    1,
  );

  // y scale across all series (numbers, or [x,y] pairs for scatter).
  let maxY = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const s of series) {
    for (const raw of asArray<unknown>(s.data)) {
      const y = Array.isArray(raw) ? num(raw[1]) : num(raw);
      maxY = Math.max(maxY, y);
      minY = Math.min(minY, y);
    }
  }
  if (type === "scatter") {
    for (const s of series) {
      for (const raw of asArray<unknown>(s.data)) {
        const pair = asArray<number>(raw);
        maxY = Math.max(maxY, num(pair[1]));
        minY = Math.min(minY, num(pair[1]));
      }
    }
  }
  if (!Number.isFinite(maxY)) maxY = 1;
  if (!Number.isFinite(minY)) minY = 0;
  const span = maxY - minY || 1;

  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const yOf = (v: number) => padT + plotH - ((v - minY) / span) * plotH;

  // axes
  ctx.setStrokeStyle("#d1d5db");
  ctx.setLineWidth(1);
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // y ticks (4 steps, plain number formatting)
  ctx.setFillStyle("#9ca3af");
  ctx.setFontSize(10);
  for (let i = 0; i <= 4; i++) {
    const v = minY + (span * i) / 4;
    const y = yOf(v);
    ctx.fillText(formatNum(v), 4, y + 3);
  }

  // x labels: at most 5, evenly sampled
  const labelStep = Math.max(1, Math.ceil(pointCount / 5));
  for (let i = 0; i < pointCount; i += labelStep) {
    const label = categories[i] !== undefined ? String(categories[i]) : String(i + 1);
    const x = padL + (plotW * (i + 0.5)) / pointCount;
    ctx.fillText(label.length > 6 ? `${label.slice(0, 6)}…` : label, x - 12, height - 10);
  }

  series.forEach((s, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length] ?? "#3b82f6";
    const data = asArray<unknown>(s.data);
    ctx.setFillStyle(color);
    ctx.setStrokeStyle(color);

    if (type === "bar") {
      const groupW = plotW / pointCount;
      const barW = Math.max(2, (groupW * 0.6) / series.length);
      data.forEach((raw, i) => {
        const v = num(raw);
        const x = padL + groupW * (i + 0.5) - (barW * series.length) / 2 + si * barW;
        const y = yOf(v);
        ctx.fillRect(x, y, barW, padT + plotH - y);
      });
      return;
    }

    if (type === "line") {
      ctx.setLineWidth(2);
      ctx.beginPath();
      data.forEach((raw, i) => {
        const v = num(raw);
        const x = padL + (plotW * (i + 0.5)) / pointCount;
        const y = yOf(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      data.forEach((raw, i) => {
        const x = padL + (plotW * (i + 0.5)) / pointCount;
        const y = yOf(num(raw));
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }

    if (type === "scatter") {
      for (const raw of data) {
        const pair = asArray<number>(raw);
        const x = padL + (plotW * (num(pair[0]) + 0.5)) / pointCount;
        const y = yOf(num(pair[1]));
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  ctx.draw();
}

function drawPie(ctx: ReturnType<typeof Taro.createCanvasContext>, series: Record<string, unknown>, width: number, height: number) {
  const data = asArray<{ name?: unknown; value?: unknown }>(series.data);
  const total = data.reduce((sum, d) => sum + num(d.value), 0) || 1;
  const cx = Math.min(width * 0.4, 160);
  const cy = height / 2;
  const r = Math.min(cx - 16, height / 2 - 16);
  let angle = -Math.PI / 2;

  data.forEach((d, i) => {
    const slice = (num(d.value) / total) * Math.PI * 2;
    ctx.setFillStyle(SERIES_COLORS[i % SERIES_COLORS.length] ?? "#3b82f6");
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fill();
    angle += slice;
  });

  // legend to the right of the pie
  ctx.setFontSize(11);
  data.forEach((d, i) => {
    const y = 24 + i * 18;
    if (y > height - 10) return;
    ctx.setFillStyle(SERIES_COLORS[i % SERIES_COLORS.length] ?? "#3b82f6");
    ctx.fillRect(cx + r + 12, y - 8, 10, 10);
    ctx.setFillStyle("#374151");
    const pct = Math.round((num(d.value) / total) * 100);
    ctx.fillText(`${String(d.name ?? "")} ${pct}%`, cx + r + 28, y);
  });

  ctx.draw();
}

function formatNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}
