// ── Work-rhythm parsing and due-time math (add-agent-residency D2/D3) ───────
//
// Shared by the pack manifest validator (shape: exactly one of every|daily,
// optional `do` prompt) and the runner's rhythm scheduler (due computation).
// Two entry shapes only — interval and daily-at-time — deliberately not cron:
// authors declare cadence, not expressions. All functions are pure; the
// scheduler owns firing policy (missed dues are skipped, never caught up).

// The interval floor — anything faster hammers the deployer's own quota for
// no useful work.
export const EVERY_FLOOR_MINUTES = 5;

// Keys a rhythm entry may carry (shared with the manifest validator).
export const RHYTHM_KEYS = ["every", "daily", "do"];

const EVERY_RE = /^(\d{1,4})([mh])$/;
const DAILY_RE = /^(\d{1,2}):(\d{2})$/;

// "90m" | "2h" → minutes (≥ the floor), else null.
export function parseEveryMinutes(v) {
  if (typeof v !== "string") return null;
  const m = EVERY_RE.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  const minutes = m[2] === "h" ? n * 60 : n;
  return minutes >= EVERY_FLOOR_MINUTES ? minutes : null;
}

// "09:30" → { hour: 9, minute: 30 }, else null.
export function parseDaily(v) {
  if (typeof v !== "string") return null;
  const m = DAILY_RE.exec(v.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// Wall-clock parts of an instant in an IANA timezone (Intl carries the tz/DST
// math; no dependency). Seconds are included so offset derivations keep ms
// precision out of the caller's way.
export function zonedParts(date, tz = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - date.getTime();
}

// The next UTC instant at or after `from` whose wall clock in `tz` reads the
// daily time. DST-safe by correction loop (≤2 passes).
export function nextDailyDue(daily, from, tz = "UTC") {
  let guess = from.getTime();
  for (let i = 0; i < 3; i++) {
    const off = offsetMs(new Date(guess), tz);
    const p = zonedParts(new Date(guess), tz);
    const wallToday = Date.UTC(p.year, p.month - 1, p.day, daily.hour, daily.minute, 0);
    let candidate = wallToday - off;
    if (candidate >= from.getTime()) {
      const check = zonedParts(new Date(candidate), tz);
      if (check.hour === daily.hour && check.minute === daily.minute) return new Date(candidate);
      // Skipped/nonexistent wall time (DST) — take the next day's occurrence.
      const tomorrowWall = wallToday + 24 * 3600 * 1000;
      candidate = tomorrowWall - offsetMs(new Date(tomorrowWall), tz);
      return new Date(candidate);
    }
    // Today's slot already passed in tz — walk a day forward and re-derive.
    guess = guess + 24 * 3600 * 1000;
  }
  return new Date(from.getTime() + 24 * 3600 * 1000);
}

// Next due instant for a rhythm entry. Interval entries fire every N minutes
// from the last fire (caller-anchored: pass the anchor as `from`); daily
// entries fire at the wall-clock time in `tz`.
export function nextDue(entry, from, tz = "UTC") {
  if (entry.every !== undefined) {
    const minutes = parseEveryMinutes(entry.every);
    if (minutes === null) return null;
    return new Date(from.getTime() + minutes * 60 * 1000);
  }
  if (entry.daily !== undefined) {
    const daily = parseDaily(entry.daily);
    if (daily === null) return null;
    return nextDailyDue(daily, from, tz);
  }
  return null;
}
