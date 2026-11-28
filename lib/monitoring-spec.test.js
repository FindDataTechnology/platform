// monitoring 段校验（enrich-fleet-template-member-config）。
//
// 每条都对着一种「看起来配了监控、实际不会响」的形态：
//   · 空 anomaly_criteria（实测事故：一个岗的判据写成空数组，三个月没人发现）
//   · 缺 escalate.threshold（出了问题没人知道找谁）
//   · notify 直连外部通道（绕过拍板队列）
//   · notify 缺失（已发布的包里，等于装了个不会响的警报器）
//
// Run: node --test lib/monitoring-spec.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { validateMonitoringSection, MONITORING_NOTIFY_VALUES, SEVERITY_LEVELS } = await import("./monitoring-spec.js");

const okSection = (over = {}) => ({
  anomaly_criteria: ["有效占用超过上限", "占用到期未释放"],
  escalate: { threshold: "核对岗无法定性或 severity=high", severity_default: "high" },
  notify: "proposal-channel",
  ...over,
});

test("合规的 monitoring ⇒ 无错误", () => {
  assert.deepEqual(validateMonitoringSection(okSection()), []);
});

test("空 anomaly_criteria ⇒ 拒收（空判据等于没有监控）", () => {
  const e = validateMonitoringSection(okSection({ anomaly_criteria: [] }));
  assert.equal(e.length, 1);
  assert.equal(e[0].code, "monitoring_criteria_empty");
});

test("只有空串的 anomaly_criteria ⇒ 同样算空", () => {
  const e = validateMonitoringSection(okSection({ anomaly_criteria: ["", "  "] }));
  assert.ok(e.some((x) => x.code === "monitoring_criteria_empty"));
});

test("缺 escalate.threshold ⇒ 拒收", () => {
  const e = validateMonitoringSection(okSection({ escalate: { severity_default: "high" } }));
  assert.ok(e.some((x) => x.code === "monitoring_threshold_missing"));
});

test("notify 缺失 ⇒ 拒收（包是已发布产物，蓝图草稿才只告警）", () => {
  const s = okSection();
  delete s.notify;
  const e = validateMonitoringSection(s);
  assert.equal(e[0].code, "monitoring_notify_missing");
});

test("notify 直连外部通道 ⇒ 拒收", () => {
  const e = validateMonitoringSection(okSection({ notify: "webhook://internal" }));
  assert.equal(e[0].code, "monitoring_notify_unsupported");
  assert.ok(e[0].error.includes("拍板"));
});

test("severity_default 非法值 ⇒ 拒收；缺省不代填", () => {
  assert.equal(validateMonitoringSection(okSection({ escalate: { threshold: "x", severity_default: "urgent" } }))[0].code, "monitoring_severity_unsupported");
  // 缺省合法（只校验「写了就必须合法」）
  assert.deepEqual(validateMonitoringSection(okSection({ escalate: { threshold: "x" } })), []);
});

test("不是对象 ⇒ 单条形状错", () => {
  assert.equal(validateMonitoringSection([])[0].code, "monitoring_not_object");
  assert.equal(validateMonitoringSection(null)[0].code, "monitoring_not_object");
});

test("闭集常量是唯一来源（与告警渠道/严重级一致）", () => {
  assert.deepEqual([...MONITORING_NOTIFY_VALUES], ["proposal-channel"]);
  assert.deepEqual([...SEVERITY_LEVELS], ["low", "normal", "high"]);
});
