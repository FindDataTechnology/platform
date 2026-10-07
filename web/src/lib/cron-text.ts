// Human-readable schedule text for scheduled tasks (spec: scheduled-tasks-ui).
// Localized phrasing for the common shapes; anything else falls back to the
// raw expression (still shown, never hidden). Weekday names come from Intl on
// the active locale — no per-day locale keys to keep in parity.

import type { CronJob } from "@platform/core";
import type { TFunction } from "i18next";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayLabel(dow: number, locale: string): string {
  // 2023-01-01 was a Sunday — offsetting it yields each weekday once.
  const date = new Date(Date.UTC(2023, 0, 1 + dow));
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(date);
}

export function describeCron(t: TFunction, expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return t("tasks.schedule.custom", { expr });
  const [min = "*", hour = "*", dom = "*", mon = "*", dow = "*"] = parts;
  if (dom === "*" && mon === "*") {
    const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return t("tasks.schedule.daily", { time: at });
    if (dow === "1-5") return t("tasks.schedule.weekdays", { time: at });
    if (/^\d+(,\d+)*$/.test(dow)) {
      return t("tasks.schedule.weeklyOn", {
        days: dow
          .split(",")
          .map((d) => WEEKDAYS[Number(d)] ?? d)
          .join(", "),
        time: at,
      });
    }
  }
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min.startsWith("*/")) return t("tasks.schedule.everyNMinutes", { n: min.slice(2) });
    if (min === "*") return t("tasks.schedule.everyMinute");
  }
  return t("tasks.schedule.custom", { expr });
}

// Schedule + timezone in one phrase; times format in the JOB's timezone when
// it declares one (the user authored the schedule in it).
export function describeJobSchedule(t: TFunction, job: CronJob, locale: string): string {
  if (job.type === "once") {
    const when = job.when
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: job.tz || undefined,
        }).format(new Date(job.when))
      : "—";
    return t("tasks.schedule.once", { when });
  }
  const text = describeCron(t, job.cron || "");
  return job.tz ? `${text} · ${job.tz}` : text;
}

export function formatInJobTz(iso: string | null, tz: string | null, locale: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tz || undefined,
  }).format(new Date(iso));
}
