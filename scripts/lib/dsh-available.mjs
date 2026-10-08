// Probe: can this machine's SHARED dsh install serve a per-user/cell DSH_HOME?
//
// A cell or integration suite runs the real dsh runtime against a fresh
// DSH_HOME; server boot (dsh-profile.js ensureDshHome) scaffolds that home and
// symlinks its two module levels from the SHARED tree ($DSH_SHARED_HOME,
// default ~/.dsh). That only resolves when the shared tree is complete:
//
//   profiles/node_modules/@deepseek-ai/…        the bundle level — created by
//                                                dsh's own healProfilesModuleFallback,
//                                                which runs on the FIRST PROFILE RUN
//                                                (not on `dsh plugin add`)
//   profiles/platform/node_modules/@deepseek-ai/…
//                                                the pinned profile deps the platform
//                                                bridges import by bare specifier
//                                                (dsh-sdk-jsonrpc-server, …)
//
// A machine with only `npm i -g dsh` + `dsh plugin add` (the CI bootstrap
// before its profile was ever RUN) has neither — every spawned dsh child dies
// with "plugin(s) failed to load". Such suites gate on this probe: they run
// wherever a real install exists (dev machines, the Docker image) and skip
// loudly elsewhere. Fixing the fresh-machine bootstrap is dsh-matrix domain
// (ADR-0007); see docs/opensource-release.md.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dshRuntimeAvailable() {
  const shared = process.env.DSH_SHARED_HOME || join(homedir(), ".dsh");
  return (
    existsSync(join(shared, "profiles", "node_modules", "@deepseek-ai", "cordis-plugin-timer")) &&
    existsSync(join(shared, "profiles", "platform", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server"))
  );
}
