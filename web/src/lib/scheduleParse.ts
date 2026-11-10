// scheduleParse.ts — plain-language schedule parsing for the automation form
// (add-projects-automation-flow). Pure client-side rules, no LLM: the common
// zh phrasings plus en basics resolve to the form's own field shape; anything
// else returns null and the manual controls stay in charge.

export interface ParsedSchedule {
  cron: string;
  /** The form's preset frequency the parse maps onto. */
  freq: "daily" | "weekly" | "weekdays" | "everyN" | "custom";
  time?: string; // "HH:MM" for daily/weekly/weekdays
  weekdays?: number[]; // 0=Sun..6=Sat for weekly
  everyN?: number; // minutes for everyN
  /** Human-readable summary shown in the preview. */
  summary: string;
}

const ZH_WEEKDAYS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};
const EN_WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

/** "早上8点" / "下午3点半" / "9:30" / "8点" → "08:00"-style, or null. */
function parseTime(text: string): { time: string; hour12?: "am" | "pm" } | null {
  const hm = text.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/);
  if (!hm) return null;
  let hour = Number(hm[1]);
  const minute = hm[2] ? Number(hm[2]) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return null;
  let hour12: "am" | "pm" | undefined;
  if (/下午|晚上|pm/i.test(text) && hour < 12) {
    hour += 12;
    hour12 = "pm";
  } else if (/上午|早上|凌晨|am/i.test(text) && hour === 12) {
    hour = 0;
    hour12 = "am";
  }
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, hour12 };
}

function cronFromTime(time: string): string {
  const [h, m] = time.split(":");
  return `${Number(m)} ${Number(h)}`;
}

function wdLabel(zh: string[], t: (zh: string) => string): string {
  return zh.map((z) => t(z)).join("/");
}

// zh weekday names for the summary line.
const ZH_WD_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * Parse a plain-language schedule. Returns null when nothing matches —
 * the form then points the user at the manual controls.
 */
export function parseSchedule(
  input: string,
  summarizeWeekday: (wd: number) => string = (wd) => ZH_WD_NAMES[wd] ?? String(wd),
): ParsedSchedule | null {
  const text = input.trim();
  if (!text) return null;
  const low = text.toLowerCase();

  // 每 N 分钟 / every N minutes
  const everyMin = low.match(/每\s*(\d{1,3})\s*分钟/) ?? low.match(/every\s*(\d{1,3})\s*min(?:ute)?s?/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    if (n >= 1 && n <= 1439) {
      return { cron: `*/${n} * * * *`, freq: "everyN", everyN: n, summary: `每 ${n} 分钟` };
    }
  }
  if (/每\s*半\s*小时|every half an? hour/.test(low)) {
    return { cron: "*/30 * * * *", freq: "everyN", everyN: 30, summary: "每 30 分钟" };
  }

  // 每小时 [第 M 分] / hourly [at :M]
  if (/每小时|hourly|每小时一次/.test(low)) {
    const m = low.match(/第?\s*(\d{1,2})\s*分/);
    const minute = m ? Math.min(59, Number(m[1])) : 0;
    return { cron: `${minute} * * * *`, freq: "custom", summary: minute ? `每小时第 ${minute} 分` : "每小时" };
  }

  // 工作日 [时间] / weekdays [at TIME]
  if (/工作日|weekdays?/.test(low)) {
    const t = parseTime(text);
    if (t) {
      return {
        cron: `${cronFromTime(t.time)} * * 1-5`,
        freq: "weekdays",
        time: t.time,
        summary: `工作日 ${t.time}`,
      };
    }
  }

  // 每月 X 日 [时间] / monthly on the Xth [at TIME]
  const monthly = text.match(/每月\s*(\d{1,2})\s*[日号]/) ?? text.match(/monthly on the (\d{1,2})/i);
  if (monthly) {
    const day = Number(monthly[1]);
    if (day >= 1 && day <= 31) {
      const t = parseTime(text) ?? { time: "09:00" };
      const [h, m] = t.time.split(":");
      return {
        cron: `${Number(m)} ${Number(h)} ${day} * *`,
        freq: "custom",
        summary: `每月 ${day} 日 ${t.time}`,
      };
    }
  }

  // 每周[一..日] [时间] / weekly on <weekday> [at TIME]
  const zhWeekly = text.match(/每周|每个星期|每周礼拜/);
  const zhWd = text.match(/周[一二三四五六日天]/);
  const enWd = low.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/);
  if ((zhWeekly || /weekly|every week/.test(low)) && (zhWd || enWd)) {
    const wd = zhWd ? ZH_WEEKDAYS[zhWd[0]![1]!] : EN_WEEKDAYS[enWd![0]!];
    if (wd !== undefined) {
      const t = parseTime(text) ?? { time: "09:00" };
      return {
        cron: `${cronFromTime(t.time)} * * ${wd}`,
        freq: "weekly",
        time: t.time,
        weekdays: [wd],
        summary: `每${summarizeWeekday(wd)} ${t.time}`,
      };
    }
  }
  // bare 周X with a time (每周一 implied): 周一早上8点
  if (zhWd && parseTime(text)) {
    const wd = ZH_WEEKDAYS[zhWd[0]![1]!] ?? 1;
    const t = parseTime(text)!;
    return {
      cron: `${cronFromTime(t.time)} * * ${wd}`,
      freq: "weekly",
      time: t.time,
      weekdays: [wd],
      summary: `每${summarizeWeekday(wd)} ${t.time}`,
    };
  }

  // 每天/每日/每天一次 [时间] / (every) daily [at TIME]
  if (/每天|每日|天天|daily|every day/.test(low)) {
    const t = parseTime(text) ?? { time: "09:00" };
    return { cron: `${cronFromTime(t.time)} * * *`, freq: "daily", time: t.time, summary: `每天 ${t.time}` };
  }
  // bare time with 每天-implied phrasing: 早上8点 → daily
  if (/^\s*(上午|早上|下午|晚上|凌晨)?\s*\d{1,2}[:：点时]/.test(text) && parseTime(text)) {
    const t = parseTime(text)!;
    return { cron: `${cronFromTime(t.time)} * * *`, freq: "daily", time: t.time, summary: `每天 ${t.time}` };
  }

  return null;
}

export const zhWeekdayName = (wd: number) => ZH_WD_NAMES[wd] ?? String(wd);
export { wdLabel };
