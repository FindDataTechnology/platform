// Unit tests — steward autostart installer (add-cell-lifecycle, chapter 2).
//
// Pins:
//   - the consent text names all three facts (resident / autostart / heartbeat)
//   - the LaunchAgent plan is per-user, zero-admin, KeepAlive-respawn, and
//     pointed at the stable bundled node + entry path
//   - the Scheduled Task plan is ONLOGON LIMITED (never elevated)
//   - the uninstall plan deregisters the launch mechanism (pid drain itself
//     rides the control plane — see test-steward-control.mjs)
//
// Run: node --test scripts/test-steward-install.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const {
  FLEET_DETAIL_NOTICE_TEXT,
  STEWARD_CONSENT_TEXT,
  stewardEntryPath,
  buildLaunchAgentPlist,
  schtasksCreateArgs,
  uninstallPlan,
  WIN_TASK_NAME,
} = await import("../electron/steward-install.js");

const nodeBin = "/Applications/Platform.app/Contents/Resources/node/bin/node";
const entry = "/Applications/Platform.app/Contents/Resources/app/supervisor/steward-main.js";

test("consent text names all three facts", () => {
  assert.match(STEWARD_CONSENT_TEXT, /常驻后台服务/);
  assert.match(STEWARD_CONSENT_TEXT, /开机自启动/);
  assert.match(STEWARD_CONSENT_TEXT, /配对.*上报心跳|心跳/);
});

// add-unified-fleet-console: the consent copy and the gateway's cell_detail
// whitelist must not drift — the copy names every metadata lane the door
// accepts (heartbeats / counts / run detail with deployment identity, source,
// merge outcome). A new whitelisted field requires a copy edit to pass this.
test("consent text enumerates the cell_detail metadata lanes", () => {
  assert.match(STEWARD_CONSENT_TEXT, /运行状态/);
  assert.match(STEWARD_CONSENT_TEXT, /包名\/名称\/版本\/启用状态|包名/);
  assert.match(STEWARD_CONSENT_TEXT, /运行时组占用/);
  assert.match(STEWARD_CONSENT_TEXT, /期望态合并结果/);
  assert.match(STEWARD_CONSENT_TEXT, /绝不含会话/);
  assert.match(FLEET_DETAIL_NOTICE_TEXT, /运行明细/);
  assert.match(FLEET_DETAIL_NOTICE_TEXT, /本机手动操作永远优先/);
});

test("launch agent: per-user, zero-admin, bundled node + stable entry path", () => {
  const plist = buildLaunchAgentPlist({ nodeBin, entryPath: entry, logDir: "/tmp/x" });
  assert.match(plist, /<string>com\.earendil\.platform\.steward<\/string>/);
  assert.ok(plist.includes(nodeBin) && plist.includes(entry), "points at the packaged node + steward entry");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, /ThrottleInterval/);
  assert.ok(!/sudo|root|Library\/LaunchDaemons/.test(plist), "zero-admin: never a daemon, never elevated");
});

test("scheduled task: ONLOGON LIMITED, idempotent create", () => {
  const args = schtasksCreateArgs({ nodeBin, entryPath: entry });
  const s = args.join(" ");
  assert.ok(s.includes("/Create") && s.includes("/TN") && s.includes(WIN_TASK_NAME));
  assert.ok(s.includes("ONLOGON") && s.includes("LIMITED"), "per-user login task, never /RL HIGHEST");
  assert.ok(s.includes("/F"), "idempotent re-create");
});

test("entry path: packaged resolves under the bundle, dev under the repo", () => {
  const packed = stewardEntryPath({ isPackaged: true, resourcesDir: "/Applications/Platform.app/Contents/Resources" });
  assert.ok(packed.endsWith(path.join("app", "supervisor", "steward-main.js")), "packaged entry sits at resources/app");
  const dev = stewardEntryPath({ isPackaged: false, projectRoot: "/repo" });
  // Compare via path.join: the implementation is path.join'd too, and a POSIX
  // literal would assert backslashes are wrong on Windows — they are not.
  assert.equal(dev, path.join("/repo", "supervisor", "steward-main.js"));
});

test("uninstall plan deregisters the launch mechanism on both platforms", () => {
  const plan = uninstallPlan();
  if (process.platform === "darwin") {
    assert.ok(plan.bootoutArgs.includes("bootout") && plan.remove.endsWith(".plist"));
  } else if (process.platform === "win32") {
    assert.ok(plan.taskArgs.join(" ").includes("/Delete"));
  }
});
