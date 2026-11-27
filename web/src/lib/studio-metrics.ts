// Studio authoring metrics (add-agent-builder-workspace 8.4). The spec asks
// for three MEASURABLE numbers — time-to-first-emit, validation-error
// resolution clicks, cast→deploy conversion — without prescribing a backend.
// The honest minimal sink is the browser-local ring (the same posture as the
// canvas position archive: user-local data, bounded, never a server shape).
// Events append to localStorage under one key; scripts/aggregate-studio-metrics
// reads an exported JSON and prints the three aggregates. No network egress.

const KEY = "platform.studio.metrics.v1";
const MAX_EVENTS = 2000;

export type StudioMetric =
  | { type: "doc_created"; at: number; docId: string; kind: string }
  | { type: "doc_opened"; at: number; docId: string }
  | { type: "emit"; at: number; docId: string; emit: "preset" | "draft" }
  | { type: "validation_error_seen"; at: number; docId: string; count: number }
  | { type: "validation_jump"; at: number; docId: string }
  | { type: "cast"; at: number; docId: string; packId: string | null }
  | { type: "deploy"; at: number; docId: string; fleetId: string | null };

export function recordStudioMetric(metric: StudioMetric): void {
  try {
    const raw = localStorage.getItem(KEY);
    const list: StudioMetric[] = raw ? JSON.parse(raw) : [];
    list.push(metric);
    // Bounded ring: drop the oldest beyond the cap (user-local hygiene).
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_EVENTS)));
  } catch {
    // Metrics must never break authoring — quota/private-mode failures stay quiet.
  }
}
