// lib/dsh-client-launch.js — spawn-spec shim for the 0.2.0 SDK client
// (unify-dsh-generation D7: the client's options API dropped command/args in
// favor of resolveDshLaunch's dshBin/profile/patches — options a platform
// spawner cannot express, because the platform composes argv itself from
// materialized patch files).
//
// The client's constructor still accepts an explicit runtime object as its
// second argument, bypassing resolveDshLaunch entirely. This helper builds
// that object from the pre-0.2.0 { command, args, cwd, env } shape, so every
// platform spawner (dsh-bridge, agent-runner, contracts runner, probes) keeps
// composing argv exactly as before. Pure host-side code: imports nothing
// @deepseek-ai.
export function dshClientRuntime({ command, args, cwd, env, requestTimeoutMs, shutdownTimeoutMs }) {
  return {
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    environment: () => env,
    description: `dsh ${args.join(" ")}`,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
  };
}
