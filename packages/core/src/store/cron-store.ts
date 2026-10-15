// Scheduled-task store (spec: cron-module / scheduled-tasks-ui).
//
// Owns the cron_* events the chat store deliberately ignores (chat-store's
// ignore-list comment: owning views subscribe themselves). Both clients wire
// this into their WS onMessage fan-out; commands flow out through whichever
// `send` the page holds — the store never owns a socket.

import { create } from "zustand";
import type { CronJob, ServerMessage } from "../types/ws";

const upsert = (jobs: CronJob[], job: CronJob) => {
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx === -1) return [...jobs, job];
  const next = jobs.slice();
  next[idx] = job;
  return next;
};

interface CronState {
  jobs: CronJob[];
  /** Last rejected action (e.g. invalid cron expression) — rendered by the owning view. */
  lastError: { action: string; message: string } | null;
  /** Last accepted creation (timestamped) — creation forms close on it. */
  lastAdded: { id: string; at: number } | null;

  apply: (m: ServerMessage) => void;
  clearError: () => void;
}

export const useCronStore = create<CronState>((set) => ({
  jobs: [],
  lastError: null,
  lastAdded: null,

  apply: (m) =>
    set((state) => {
      switch (m.type) {
        case "cron_jobs":
          return { jobs: m.jobs };
        case "cron_status":
          return { jobs: upsert(state.jobs, m.job) };
        case "cron_added":
          return { jobs: upsert(state.jobs, m.job), lastAdded: { id: m.job.id, at: Date.now() } };
        case "cron_removed":
          return { jobs: state.jobs.filter((j) => j.id !== m.id) };
        case "cron_fired": {
          // Optimistic running marker; the engine's cron_status (running)
          // follows immediately and reconciles.
          const idx = state.jobs.findIndex((j) => j.id === m.id);
          const job = idx >= 0 ? state.jobs[idx] : null;
          if (!job) return {};
          const next = state.jobs.slice();
          next[idx] = { ...job, status: "running", state: "running" };
          return { jobs: next };
        }
        case "cron_completed": {
          // The execution outcome is authoritative here (state field); the
          // full cron_status broadcast follows and reconciles everything else.
          const idx = state.jobs.findIndex((j) => j.id === m.id);
          const job = idx >= 0 ? state.jobs[idx] : null;
          if (!job) return {};
          const next = state.jobs.slice();
          next[idx] = {
            ...job,
            state: (m.state as CronJob["state"]) ?? (m.success === false ? "failed" : job.state),
          };
          return { jobs: next };
        }
        // Acks that only confirm acceptance (pause/resume/run); state changes
        // arrive as cron_status broadcasts.
        case "cron_paused":
        case "cron_resumed":
        case "cron_run_started":
          return {};
        case "cron_error":
          return { lastError: { action: m.action, message: m.message } };
        default:
          return {};
      }
    }),

  clearError: () => set({ lastError: null }),
}));
