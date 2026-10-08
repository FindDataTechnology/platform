// ── Rhythm scheduler (add-agent-residency 4.1, design D2/D3) ────────────────
//
// Fires self-turns at the effective rhythm's due times. Every fire rides the
// manager's SAME acquire/queue face as messages (one queueing discipline),
// lands in the agent's tz-day session (the stream the rollover digest
// summarizes), and is observable + metered (kind "self"). Missed dues are
// skipped — restart, pause, and warm-zone gaps all re-anchor; a restart never
// fires a catch-up burst (spec: agent-residency "Missed dues are skipped").

import { nextDue, zonedParts, parseEveryMinutes } from "../lib/rhythm.js";

export const DEFAULT_SELF_PROMPT =
  "按你的角色职责，执行本轮节奏工作：回顾当前状态，完成应做的推进，并简述结果。";

export class RhythmScheduler {
  constructor({ manager, rollover = null, config, log = console, now = () => Date.now() }) {
    this.manager = manager;
    this.rollover = rollover; // optional: injects the pending digest at the day's head
    this.config = config;
    this.log = log;
    this.now = now;
    this.anchors = new Map(); // `${key}#${idx}` → Date the schedule is anchored at
    this.firing = new Set(); // keys with a self-turn in flight (one per agent)
  }

  // The autonomous day-session id — one per agent per tz-day (design D4).
  daySessionId() {
    const p = zonedParts(new Date(this.now()), this.config.tz);
    return `srv-day-${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;
  }

  async tick() {
    for (const [key, entry] of this.manager.entries) {
      const rhythm = entry.metadata?.effective_rhythm;
      if (this.manager.pausedKeys.has(key) || !Array.isArray(rhythm) || rhythm.length === 0) {
        // Paused (or rhythm-less): drop anchors so a resume re-anchors from
        // now — the paused window's dues are skipped by definition.
        for (const id of [...this.anchors.keys()]) {
          if (id.startsWith(`${key}#`)) this.anchors.delete(id);
        }
        continue;
      }
      for (let i = 0; i < rhythm.length; i++) {
        const id = `${key}#${i}`;
        if (!this.anchors.has(id)) this.anchors.set(id, new Date(this.now())); // first seen: fires one period later
        const anchor = this.anchors.get(id);
        const due = nextDue(rhythm[i], anchor, this.config.tz);
        if (!due || this.now() < due.getTime()) continue;
        this.anchors.set(id, due); // keep the schedule aligned, not wall-clock sloppy
        // Stale due (we're a full period past it — restart/pause/warm gap):
        // skip this occurrence and re-anchor from now, so the schedule RESUMES
        // at the next due instead of staying missed forever. Never catch up.
        const period = periodMs(rhythm[i]);
        if (period !== null && this.now() - due.getTime() >= period) {
          this.anchors.set(id, new Date(this.now()));
          continue;
        }
        if (this.firing.has(key)) continue; // one in-flight self-turn per agent
        this.firing.add(key);
        this.#fire(key, entry, rhythm[i]).catch(() => {}).finally(() => this.firing.delete(key));
      }
    }
  }

  async #fire(key, entry, rhythmEntry) {
    const base = typeof rhythmEntry.do === "string" && rhythmEntry.do.trim() ? rhythmEntry.do : DEFAULT_SELF_PROMPT;
    // The day's first fire carries the pending digest at the session head
    // (design D4: the new day opens with the 昨日纪要 injected).
    const digest = this.rollover?.takePendingDigest?.(key);
    const prompt = digest ? `【昨日纪要】\n${digest}\n\n（以上为昨日纪要，今日工作在此基础上继续。）\n\n${base}` : base;
    this.log.log(`[agent-runner] rhythm: self-turn for ${key} (${rhythmEntry.every ?? rhythmEntry.daily ?? "?"})`);
    try {
      await this.manager.selfTurn(entry, prompt, this.daySessionId());
    } catch (e) {
      // Paused mid-flight, spawn failure, or turn error: logged, never retried
      // out of band — the next due time fires naturally.
      this.log.warn(`[agent-runner] rhythm self-turn failed for ${key}: ${e.message}`);
    }
  }
}

function periodMs(entry) {
  if (entry.every !== undefined) {
    const minutes = parseEveryMinutes(entry.every);
    return minutes === null ? null : minutes * 60_000;
  }
  return 24 * 3600 * 1000; // daily
}
