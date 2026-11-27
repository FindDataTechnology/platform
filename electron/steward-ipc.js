// ── Steward IPC (add-cell-lifecycle, chapter 2) ─────────────────────────────
//
// The install/uninstall actions behind the Preferences "后台管家" section.
// Registration itself is per-user and zero-admin (LaunchAgent / schtasks);
// the install handler also proves the steward actually came up by attaching
// to its control plane before answering, so the UI never reports "installed"
// for a binary that failed to launch.

import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FLEET_DETAIL_NOTICE_TEXT,
  STEWARD_CONSENT_TEXT,
  installPlan,
  uninstallPlan,
  launchAgentPlistPath,
  registrationArtifacts,
  stewardEntryPath,
  WIN_TASK_NAME,
} from "./steward-install.js";
import { attachSteward } from "../supervisor/steward-client.js";
import { createCrashGuard } from "../supervisor/steward-health.js";

const execFileP = promisify(execFile);

export function registerStewardIpc({ dataDir, nodeBin, projectRoot, isPackaged }) {
  ipcMain.handle("steward:consent", () => ({
    consentText: STEWARD_CONSENT_TEXT,
    // add-unified-fleet-console D7: already-paired installs learn about the
    // 运行明细 lane via a one-time preferences notice (informational).
    fleetDetailNoticeText: FLEET_DETAIL_NOTICE_TEXT,
  }));

  // Crash-loop history (add-desktop-residency-hardening 2.x): the same guard
  // the resident entry uses, read from the data root — the UI never guesses.
  const crashGuard = createCrashGuard({ dataDir });
  const crash = () => crashGuard.status();

  ipcMain.handle("steward:status", async () => {
    const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
    const health = crash();
    // Three honest states: registered+healthy / registered+unhealthy / not
    // registered. "Registered" is NEVER derived from a file alone — a plist
    // that exists while the process is dead is the unhealthy state, and the
    // UI must say so (spec: 注册在而进程死显示未健康).
    if (att.ok) {
      const ps = await att.client.request("pairStatus").catch(() => ({}));
      return {
        installed: true,
        running: true,
        state: "healthy",
        protocolVersion: att.discovery?.protocolVersion ?? null,
        pid: att.discovery?.pid ?? null,
        paired: ps.paired === true,
        pairDeviceId: ps.deviceId ?? null,
        error: null,
        crash: health,
      };
    }
    const registered = installed();
    return {
      installed: registered,
      running: false,
      state: registered ? (health.coolingDown ? "unhealthy" : "unhealthy") : "not_installed",
      protocolVersion: att.discovery?.protocolVersion ?? null,
      pid: att.discovery?.pid ?? null,
      paired: false,
      pairDeviceId: null,
      error: att.reason ?? null,
      crash: health,
    };
  });

  // Repair (add-desktop-residency-hardening 3.x): re-register the autostart
  // (idempotent — replace, never duplicate) and clear the crash history so
  // the next boot is a fresh attempt. The human is in the loop, so the guard
  // stands down for this attempt.
  ipcMain.handle("steward:repair", async () => {
    const plan = installPlan({ isPackaged, nodeBin, dataDir, projectRoot });
    if (plan.platform === "unsupported") return { ok: false, error: `unsupported platform: ${process.platform}` };
    try {
      if (plan.platform === "darwin") {
        fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
        fs.writeFileSync(plan.plistPath, plan.plistContent);
        await execFileP("launchctl", plan.bootstrappArgs ?? plan.bootstrapArgs).catch(async () => {
          await execFileP("launchctl", ["kickstart", "-k", `gui/${String(process.getuid())}/com.earendil.platform.steward`]);
        });
      } else {
        // /F replaces an existing task — the idempotent path.
        await execFileP("schtasks", plan.taskArgs);
        await execFileP("schtasks", ["/Run", "/TN", WIN_TASK_NAME]).catch(() => {});
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
    crashGuard.clear();
    return { ok: true, artifacts: registrationArtifacts({
      platform: process.platform,
      nodeBin,
      entryPath: stewardEntryPath({ isPackaged, projectRoot, resourcesDir: process.resourcesPath }),
      logDir: path.join(dataDir, "logs"),
    }) };
  });

  // Pairing = the explicit opt-in for uplink (add-cell-lifecycle 4.1/4.3).
  // The control plane validates and stores the identity; the renderer passes a
  // six-digit bind code + a display label.
  ipcMain.handle("steward:pair", async (_ev, { code, label }) => {
    const att = await attachSteward(dataDir).catch(() => null);
    if (!att?.ok) return { ok: false, error: "后台管家不在运行——先安装并启动" };
    const r = await att.client.request("pair", { code, label }).catch((e) => ({ error: e.message }));
    return r.error ? { ok: false, error: r.error } : { ok: true, email: r.email ?? null };
  });

  ipcMain.handle("steward:unpair", async () => {
    const att = await attachSteward(dataDir).catch(() => null);
    if (!att?.ok) return { ok: false, error: "后台管家不在运行" };
    const r = await att.client.request("unpair").catch((e) => ({ error: e.message }));
    return r.error ? { ok: false, error: r.error } : { ok: true };
  });

  ipcMain.handle("steward:install", async () => {
    const plan = installPlan({ isPackaged, nodeBin, dataDir, projectRoot });
    if (plan.platform === "unsupported") return { ok: false, error: `unsupported platform: ${process.platform}` };
    if (plan.platform === "darwin") {
      fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
      fs.writeFileSync(plan.plistPath, plan.plistContent);
      await execFileP("launchctl", plan.bootstrappArgs ?? plan.bootstrapArgs).catch(async () => {
        // Older aliases: kickstart as the bootstrap fallback.
        await execFileP("launchctl", ["kickstart", "-k", `gui/${String(process.getuid())}/com.earendil.platform.steward`]);
      });
    } else {
      await execFileP("schtasks", plan.taskArgs);
      await execFileP("schtasks", ["/Run", "/TN", WIN_TASK_NAME]).catch(() => {});
    }
    // Prove it came up: the discovery file + a hello on the control plane.
    const deadline = Date.now() + 8000;
    for (;;) {
      const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
      if (att.ok) return { ok: true, pid: att.discovery?.pid };
      if (Date.now() > deadline) return { ok: false, error: "steward registered but did not answer its control plane within 8s" };
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  ipcMain.handle("steward:uninstall", async () => {
    // Drain first (best-effort): the steward stops the runtime stack itself,
    // so no orphan children survive deregistration.
    const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
    if (att.ok) await att.client.request("drainQuit").catch(() => {});
    const plan = uninstallPlan();
    if (plan.platform === "darwin") {
      await execFileP("launchctl", plan.bootoutArgs).catch(() => {});
      if (plan.remove) fs.rmSync(plan.remove, { force: true });
    } else if (plan.platform === "win32") {
      await execFileP("schtasks", plan.taskArgs).catch(() => {});
    }
    return { ok: true };
  });
}

function installed() {
  if (process.platform === "darwin") return fs.existsSync(launchAgentPlistPath());
  if (process.platform === "win32") return true; // schtasks /Query is answered by the running state probe instead
  return false;
}
