// ── Steward autostart installer (add-cell-lifecycle, chapter 2) ────────────
//
// Per-user, zero-admin registration of the resident steward:
//   macOS   ~/Library/LaunchAgents/<appId>.steward.plist  (KeepAlive)
//   Windows schtasks ONLOGON LIMITED (no UAC), entry "PlatformSteward"
//
// Consent is explicit and names the three facts (spec: resident service,
// launch-at-login, and — once paired — heartbeat reporting). The uninstall
// path deregisters AND stops; on macOS a drag-deleted .app can't run hooks,
// so the steward also self-cleans when its bundle is gone (see steward-main).

import os from "node:os";
import path from "node:path";

// Consent names the three facts (spec: resident service, launch-at-login, and
// — once paired — the three metadata lanes it may report). add-unified-fleet-
// console expanded lane ③ to name every cell_detail field individually: the
// whitelist text and the actual whitelist must not drift.
export const STEWARD_CONSENT_TEXT =
  "安装后台管家将开启三件事：\n" +
  "1. 一个常驻后台服务（退出应用后，舰队与定时任务继续运行）；\n" +
  "2. 开机自启动（登录本机后自动拉起，不需要管理员权限）；\n" +
  "3. 若之后完成配对，将向平台上报三类纯元数据（绝不含会话、提示词或工具内容）：\n" +
  "   · 心跳——在线状态、系统形态、应用版本；\n" +
  "   · 需求计数——舰队数、岗位数、启用任务数与名称标签；\n" +
  "   · 运行明细——机上 agent 的运行状态、部署条目的包名/名称/版本/启用状态、\n" +
  "     运行时组占用、期望态合并结果与拒绝原因。配对后平台可下发本机的部署期望，\n" +
  "     由本机收敛执行（本机手动操作永远优先）。";

// Already-paired installs learned about the 运行明细 lane after the fact:
// the preferences page shows this notice once on the first launch after the
// update (design D7) — informational, not a gate, because every listed field
// is still content-free metadata inside the consented trust boundary.
export const FLEET_DETAIL_NOTICE_TEXT =
  "本次更新后，配对设备将额外上报「运行明细」纯元数据：机上 agent 的运行状态、部署条目的" +
  "包名/名称/版本/启用状态、运行时组占用、期望态合并结果与拒绝原因；同时平台可为这台机器" +
  "下发部署期望（由本机收敛执行，本机手动操作永远优先）。绝不上报会话、提示词或工具内容。" +
  "如不希望上报，可解除配对或关闭后台管家。";

export function stewardEntryPath({ isPackaged, resourcesDir = process.resourcesPath, projectRoot }) {
  return isPackaged
    ? path.join(resourcesDir, "app", "supervisor", "steward-main.js")
    : path.join(projectRoot, "supervisor", "steward-main.js");
}

// ── macOS — LaunchAgent ────────────────────────────────────────────────────

export function launchAgentPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.earendil.platform.steward.plist");
}

export function buildLaunchAgentPlist({ nodeBin, entryPath, logDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.earendil.platform.steward</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(entryPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${escapeXml(logDir)}/steward.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(logDir)}/steward.log</string>
</dict>
</plist>
`;
}

// ── Windows — Scheduled Task (modern XML-free path, schtasks CLI) ──────────

export const WIN_TASK_NAME = "PlatformSteward";
export function schtasksCreateArgs({ nodeBin, entryPath }) {
  return ["/Create", "/TN", WIN_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", `"${nodeBin}" "${entryPath}"`];
}
export const schtasksDeleteArgs = ["/Delete", "/TN", WIN_TASK_NAME, "/F"];

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// install() returns a plan; callers execute. Kept side-effect-light so the
// wizard can show what will happen before the user confirms.
export function installPlan({ isPackaged, nodeBin, dataDir, projectRoot, resourcesDir = process.resourcesPath }) {
  const entryPath = stewardEntryPath({ isPackaged, resourcesDir, projectRoot });
  const logDir = path.join(dataDir, "logs");
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      plistPath: launchAgentPlistPath(),
      plistContent: buildLaunchAgentPlist({ nodeBin, entryPath, logDir }),
      bootstrapArgs: ["bootstrap", `gui/${String(process.getuid?.() ?? "")}`, launchAgentPlistPath()],
    };
  }
  if (process.platform === "win32") {
    return { platform: "win32", taskArgs: schtasksCreateArgs({ nodeBin, entryPath }) };
  }
  return { platform: "unsupported" };
}

export function uninstallPlan() {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      plistPath: launchAgentPlistPath(),
      bootoutArgs: ["bootout", `gui/${String(process.getuid?.() ?? "")}`, launchAgentPlistPath()],
      remove: launchAgentPlistPath(),
    };
  }
  if (process.platform === "win32") return { platform: "win32", taskArgs: ["/Delete", "/TN", WIN_TASK_NAME, "/F"] };
  return { platform: "unsupported" };
}

// ── Assertable registration artifacts (add-desktop-residency-hardening 1.x) ─
//
// The registration must be verifiable WITHOUT driving the OS: launchctl is
// not deterministic on a CI runner, and schtasks output differs across
// Windows builds. So the plan is described as DATA: the exact argv, the exact
// plist fields, and the stable target path. Tests assert this shape; a
// real-machine run (win-smoke) then asserts the OS agrees with it.
export function registrationArtifacts({ platform = process.platform, nodeBin, entryPath, logDir } = {}) {
  if (platform === "darwin") {
    const plist = buildLaunchAgentPlist({ nodeBin, entryPath, logDir });
    return {
      platform: "darwin",
      kind: "launch-agent",
      path: launchAgentPlistPath(),
      // Parsed from the artifact itself — the test asserts the artifact, not a
      // second description of it.
      fields: {
        runAtLoad: /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist),
        // KeepAlive ships as a dict ({SuccessfulExit: false}) — "respawn
        // unless the process exited cleanly" — not as a bare <true/>.
        keepAlive: /<key>KeepAlive<\/key>/.test(plist),
        keepAliveOnSuccessfulExit: /<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist),
        throttleInterval: Number((plist.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/) ?? [])[1] ?? 0),
        programArguments: (plist.match(/<string>[^<]*<\/string>/g) ?? []).map((s) => s.replace(/<\/?string>/g, "")),
        logDir: logDir ?? null,
      },
      targetPath: entryPath ?? null,
      plist,
    };
  }
  if (platform === "win32") {
    const args = schtasksCreateArgs({ nodeBin, entryPath });
    const flag = (name) => {
      const i = args.indexOf(`/${name}`);
      return i >= 0 ? args[i + 1] : null;
    };
    return {
      platform: "win32",
      kind: "scheduled-task",
      taskName: flag("TN"),
      trigger: flag("SC"),
      runLevel: flag("RL"),
      force: args.includes("/F"),
      args,
      targetPath: entryPath ?? null,
    };
  }
  return { platform: "unsupported", kind: null };
}
