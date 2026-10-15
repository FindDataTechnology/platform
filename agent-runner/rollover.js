// ── Day rollover + carry-over digest (add-agent-residency 5.1, design D4) ───
//
// Per agent, the autonomous day-session rolls at the tz day boundary: a
// digest self-turn (kind "digest", metered like any turn) summarizes the
// outgoing day session, the digest lands in the external archive (≤1-day loss
// window on host death), and the NEXT day's session opens with the digest at
// its head (the scheduler consumes the pending digest on the day's first
// fire). Warm agents roll on their next re-warm (spawn hook); paused agents
// skip the day entirely. Session files stay in the private home — the digest
// is the durable carry-over.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { zonedParts } from "../lib/rhythm.js";

export const DIGEST_PROMPT =
  "总结今日会话的关键进展、未决事项与明日要点，写成一份简洁的「明日纪要」（512字内）。只输出纪要正文。";

export class Rollover {
  constructor({ manager, config, log = console, now = () => Date.now() }) {
    this.manager = manager;
    this.config = config;
    this.log = log;
    this.now = now;
    this.rolling = new Set(); // one roll in flight per agent
  }

  #dayKey(at = this.now()) {
    const p = zonedParts(new Date(at), this.config.tz);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }

  #homeOf(key) {
    return path.join(this.config.homeRoot, key);
  }

  #markerOf(key) {
    return path.join(this.#homeOf(key), "last-roll.json");
  }

  // The pending digest for TODAY's head (consumed exactly once by the
  // scheduler's first fire of the day).
  #pendingOf(key) {
    return path.join(this.#homeOf(key), "pending-digest.json");
  }

  takePendingDigest(key) {
    try {
      const p = this.#pendingOf(key);
      if (!existsSync(p)) return null;
      const doc = JSON.parse(readFileSync(p, "utf8"));
      if (doc.day !== this.#dayKey()) {
        rmSync(p, { force: true }); // stale from a skipped day — drop it
        return null;
      }
      rmSync(p, { force: true });
      return typeof doc.text === "string" ? doc.text.slice(0, this.config.digestMaxChars) : null;
    } catch {
      return null;
    }
  }

  // Timer-driven check for resident children (index.js wires the cadence).
  async check() {
    const day = this.#dayKey();
    for (const [key, entry] of this.manager.entries) {
      if (this.manager.pausedKeys.has(key)) continue; // paused: skip the day
      if (!this.manager.children.has(key)) continue; // warm: rolls on re-warm
      await this.#roll(key, entry, day);
    }
  }

  // Spawn hook (manager.onSpawnHook): a warm agent that crossed the boundary
  // rolls as part of its re-warm.
  async onSpawn(key, entry) {
    await this.#roll(key, entry, this.#dayKey());
  }

  async #roll(key, entry, today) {
    if (this.rolling.has(key)) return;
    this.rolling.add(key);
    try {
      const markerPath = this.#markerOf(key);
      let last = null;
      if (existsSync(markerPath)) {
        try {
          last = JSON.parse(readFileSync(markerPath, "utf8"));
        } catch { /* unreadable marker: treat as absent */ }
      }
      if (!last) {
        // First ever sighting: no prior day to summarize — open the marker.
        this.#writeMarker(markerPath, today);
        return;
      }
      if (last.day === today) return; // already rolled
      const ymd = String(last.day).replace(/-/g, "");
      const yesterdaySession = `srv-day-${ymd}`;
      // The digest self-turn summarizes the outgoing day session. Failures
      // log and leave the marker stale — the next check/spawn retries.
      const out = await this.manager.turn(entry, yesterdaySession, DIGEST_PROMPT, { kind: "digest" });
      const digest = String(out?.text ?? "").trim().slice(0, this.config.digestMaxChars);
      mkdirSync(path.join(this.config.archiveDir, key), { recursive: true });
      if (digest) {
        writeFileSync(
          path.join(this.config.archiveDir, key, `${ymd}.md`),
          `# ${last.day} 纪要 — ${key}\n\n${digest}\n`,
        );
        writeFileSync(this.#pendingOf(key), JSON.stringify({ day: today, text: digest }));
      }
      // Session archive (spec: agent-residency — digest AND session files
      // land on the target): copy whatever session-shaped dirs the private
      // home holds. Best-effort — an absent dir simply archives nothing.
      const home = this.#homeOf(key);
      for (const dir of ["sessions", "projects", ".sessions"]) {
        const src = path.join(home, dir);
        if (existsSync(src)) {
          try {
            cpSync(src, path.join(this.config.archiveDir, key, ymd, dir), { recursive: true });
          } catch (e) {
            this.log.warn(`[agent-runner] rollover session copy failed (${dir}): ${e.message}`);
          }
        }
      }
      this.#writeMarker(markerPath, today);
      this.log.log(`[agent-runner] rollover: ${key} rolled ${last.day} → ${today} (digest ${digest ? "saved" : "empty"})`);
    } catch (e) {
      this.log.warn(`[agent-runner] rollover failed for ${key}: ${e.message}`);
    } finally {
      this.rolling.delete(key);
    }
  }

  #writeMarker(markerPath, day) {
    try {
      mkdirSync(path.dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, JSON.stringify({ day }));
    } catch (e) {
      this.log.warn(`[agent-runner] rollover marker write failed: ${e.message}`);
    }
  }
}
