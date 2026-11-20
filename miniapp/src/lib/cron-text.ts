// 定时任务的中文排程文案(spec: scheduled-tasks-ui)。小程序无 i18n 运行时,
// 按会话页约定直接用中文字面量;常见形态给人话,其余回退原始表达式。

import type { CronJob } from "@platform/core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron“${expr}”`;
  const [min = "*", hour = "*", dom = "*", mon = "*", dow = "*"] = parts;
  if (dom === "*" && mon === "*") {
    const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `每天 ${at}`;
    if (dow === "1-5") return `工作日 ${at}`;
    if (/^\d+(,\d+)*$/.test(dow)) {
      return `每周 ${dow.split(",").map((d) => WEEKDAYS[Number(d)] ?? d).join("、")} ${at}`;
    }
  }
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min.startsWith("*/")) return `每 ${min.slice(2)} 分钟`;
    if (min === "*") return "每分钟";
  }
  return `cron“${expr}”`;
}

export function describeJobSchedule(job: Pick<CronJob, "type" | "cron" | "when" | "tz">): string {
  if (job.type === "once") {
    const when = job.when ? formatInJobTz(job.when, job.tz) : "—";
    return `${when} 一次`;
  }
  const text = describeCron(job.cron || "");
  return job.tz ? `${text} · ${job.tz}` : text;
}

export function formatInJobTz(iso: string | null, tz: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  try {
    // 以任务时区格式化(用户以该时区创建的排程)
    const fmt = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz || undefined,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return fmt.format(d);
  } catch {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
