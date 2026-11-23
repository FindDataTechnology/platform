// ── 监控声明 spec (openspec: enrich-fleet-template-member-config 任务 5 扩展) ────
//
// 团队包的 `monitoring` 说明「什么算异常、什么时候找人拍板、通知走哪条通道」。
// 这三件是本仓真实事故换来的：
//
//   · `anomaly_criteria` 写空 = **没有监控**，而页面上它看起来和其他舰队一样健康
//     （实测：一个岗位的判据写成空数组，三个月没人发现）。
//   · `escalate.threshold` 缺 = 出了问题没人知道该找谁；`severity_default` 缺 =
//     所有告警一个颜色。
//   · `notify` 直连外部通道 = 绕过拍板队列，等于把「该由人定的事」静默发出去。
//
// 与 `fleet-packs/scripts/check_blueprint.py` 的 B5 同规（蓝图与包走同一套口径），
// 差别只有一处：这里把 **notify 缺失也判红**——蓝图那条是警告，因为蓝图是草稿；
// 包是**已发布产物**，缺通知通道的监控等于装了一个不会响的警报器。
//
// 零依赖：与 board-spec / console-blocks-spec 同一姿态。

export const MONITORING_NOTIFY_VALUES = Object.freeze(["proposal-channel"]);
export const SEVERITY_LEVELS = Object.freeze(["low", "normal", "high"]);
export const MONITORING_LIMITS = Object.freeze({
  maxCriteria: 20,
  maxCriterionChars: 300,
  maxThresholdChars: 300,
});

/**
 * 校验一份 `monitoring` 段。缺席由调用方决定（团队包建议有、纯技能包无关）。
 */
export function validateMonitoringSection(section) {
  const errors = [];
  const fail = (message, entry, code) => errors.push({ error: message, entry, ...(code ? { code } : {}) });

  if (!section || typeof section !== "object" || Array.isArray(section)) {
    fail(`monitoring must be an object (got ${section === null ? "null" : Array.isArray(section) ? "array" : typeof section})`, "monitoring", "monitoring_not_object");
    return errors;
  }

  const crit = section.anomaly_criteria;
  if (!Array.isArray(crit)) {
    fail("monitoring.anomaly_criteria must be an array of strings — 写清「什么算异常」", "monitoring.anomaly_criteria", "monitoring_criteria_missing");
  } else if (!crit.some((c) => typeof c === "string" && c.trim())) {
    // 空数组是最危险的一种：它看起来「配了 monitoring」，实际一个判据都没有。
    fail(
      "monitoring.anomaly_criteria is empty — 空判据等于没有监控，而页面上它和其他舰队一样健康（这是实测事故，不是假想）",
      "monitoring.anomaly_criteria",
      "monitoring_criteria_empty",
    );
  } else {
    if (crit.length > MONITORING_LIMITS.maxCriteria) {
      fail(`monitoring.anomaly_criteria has ${crit.length} entries; at most ${MONITORING_LIMITS.maxCriteria}`, "monitoring.anomaly_criteria");
    }
    crit.forEach((c, i) => {
      if (typeof c !== "string" || !c.trim()) {
        fail(`monitoring.anomaly_criteria[${i}] must be a non-empty string`, `monitoring.anomaly_criteria[${i}]`);
      } else if (c.length > MONITORING_LIMITS.maxCriterionChars) {
        fail(`monitoring.anomaly_criteria[${i}] is ${c.length} chars; at most ${MONITORING_LIMITS.maxCriterionChars}`, `monitoring.anomaly_criteria[${i}]`);
      }
    });
  }

  const esc = section.escalate;
  if (!esc || typeof esc !== "object" || Array.isArray(esc)) {
    fail("monitoring.escalate must declare a threshold and a default severity — 出了问题才有人知道找谁", "monitoring.escalate", "monitoring_escalate_missing");
  } else {
    const th = typeof esc.threshold === "string" ? esc.threshold.trim() : "";
    if (!th) {
      fail("monitoring.escalate.threshold must be a non-empty string", "monitoring.escalate.threshold", "monitoring_threshold_missing");
    } else if (th.length > MONITORING_LIMITS.maxThresholdChars) {
      fail(`monitoring.escalate.threshold is ${th.length} chars; at most ${MONITORING_LIMITS.maxThresholdChars}`, "monitoring.escalate.threshold");
    }
    // severity_default 缺省时平台按 normal 处理——但「缺省」与「写了 normal」在读数上
    // 必须可区分，所以这里只校验**写了就必须合法**，不代填。
    if (esc.severity_default !== undefined && !SEVERITY_LEVELS.includes(esc.severity_default)) {
      fail(
        `monitoring.escalate.severity_default '${esc.severity_default}' must be one of ${SEVERITY_LEVELS.join(", ")}`,
        "monitoring.escalate.severity_default",
        "monitoring_severity_unsupported",
      );
    }
  }

  const notify = section.notify;
  if (notify === undefined || notify === null) {
    fail(
      "monitoring.notify is required — 缺通知通道的监控等于装了一个不会响的警报器（蓝图草稿这一条只告警，包是已发布产物，必须判红）",
      "monitoring.notify",
      "monitoring_notify_missing",
    );
  } else if (!MONITORING_NOTIFY_VALUES.includes(notify)) {
    fail(
      `monitoring.notify '${notify}' must be '${MONITORING_NOTIFY_VALUES.join("' or '")}' — 通知不得绕过拍板队列直连外部通道`,
      "monitoring.notify",
      "monitoring_notify_unsupported",
    );
  }

  return errors;
}
