// ── electron-builder configuration ──────────────────────────────────────────
//
// Produces a distributable Platform desktop app. Key choices:
//   - asar: false  → the bundled standalone Node (not Electron's) runs server.js
//     and must read server.js + node_modules as real files (standalone Node
//     cannot read inside an asar archive). Native addons (better-sqlite3,
//     tree-sitter) run on the bundled Node's standard ABI - no rebuild.
//   - extraResources: resources/node → <app>/Resources/node  (the bundled Node)
//   - mac arm64 + win x64 targets. The bundled-resource build (scripts/build-*.js)
//     is cross-platform Node.
//
// Build branding (openspec: add-deployment-branding): PRODUCT_NAME renames the
// app/installers (fork branding without editing source); the icon is the
// vendored build/icon.png unless scripts/fetch-build-icon.js (run by predist)
// downloaded a fork's ICON_URL to build/icon.downloaded.png.
//
// Build with:  npm run dist

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computePackagedTree } from "./scripts/lib/packaged-tree.mjs";
import { RUNTIME_DIRS } from "./scripts/lib/runtime-dirs.mjs";

const productName = (process.env.PRODUCT_NAME || "").trim() || "Platform";
const icon = existsSync("build/icon.downloaded.png") ? "build/icon.downloaded.png" : "build/icon.png";
const companyName = (process.env.COMPANY_NAME || "").trim() || undefined;

// afterPack: sync the RUNTIME node_modules into the packaged app verbatim,
// bypassing electron-builder's collector.
//
// The collector walks package.json dependencies+optionalDependencies only —
// it never follows peerDependencies. The 0.2.0 dsh graph reaches ~64
// foundation/plugin packages (dsh-sdk-protocol, dsh-fs, dsh-sandbox,
// dsh-llm-deepseek, …) exclusively via peers, and THOSE packages carry their
// own unscoped deps (brotli, sharp binaries, …) that are equally unreachable.
// npm ci auto-installs the whole resolved tree (so the build tree looks
// healthy), but the collector silently drops every peer-only package AND its
// deps from the package. v1.3.9's exe died exactly there ("Cannot find
// package '@deepseek-ai/dsh-sdk-protocol'" — debug run 38554132682; the
// app-spawned backend crash-looped, which win-smoke read as "node.exe alive,
// port never listens"). The old 39-row manifest carried these rows by hand;
// the slimmed manifest cannot, and no hand list covers their transitive deps.
//
// The predist-prepared tree (npm ci + matrix merge + shared prune) IS the
// shipping shape, so this hook copies it as-is minus the DEV-ONLY set
// (everything reachable from devDependencies but not from dependencies —
// electron, electron-builder, playwright, typescript, …). verify-bundle's
// collector-coverage gate independently proves no package in that dev set is
// required by anything shipping.
async function afterPack(context) {
  const appDir =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
      : join(context.appOutDir, "resources", "app");
  const nmSrc = join(process.cwd(), "node_modules");
  const nmDest = join(appDir, "node_modules");
  if (!existsSync(join(nmSrc, "@deepseek-ai", "dsh"))) {
    throw new Error("afterPack: project runtime tree missing — run predist first");
  }

  const rootPkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const { ships } = computePackagedTree({ nmDir: nmSrc, rootPkg });

  let pruned = [];
  try {
    pruned = JSON.parse(readFileSync(join(process.cwd(), "dsh-matrix", "prune.json"), "utf8"))
      .prune.flatMap((e) => e.match);
  } catch { /* no prune list = nothing to skip */ }
  const isPruned = (name) => pruned.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

  // Mirror the files-list trim negations (docs/markdown/test fat).
  const TRIM_FILE = /\.(md|markdown|ts|map|coffee|flow)$/;
  const TRIM_DIR = /[\\/](test|tests|docs|\.github)[\\/]/;

  let copied = 0;
  for (const name of ships) {
    if (isPruned(name)) continue;
    const src = join(nmSrc, name);
    const dest = join(nmDest, name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, {
      recursive: true,
      dereference: false,
      filter: (p) => {
        const rel = p.slice(src.length);
        return !rel || !(TRIM_FILE.test(rel) || TRIM_DIR.test(rel));
      },
    });
    copied++;
  }
  console.log(`afterPack: runtime node_modules synced verbatim (${copied} packages, dev-only and pruned excluded)`);
}

/** @type {import('electron-builder').Configuration['extraResources']} */
const extraResources = [
  {
    from: "resources/node/",
    to: "node/",
    filter: ["**/*", "!*.tar.gz"],
  },
];

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: "com.earendil.platform",
  productName,
  icon,
  // `app` pinned to the project root, explicitly. Without it electron-builder
  // probes DEFAULT_APP_DIR_NAMES = ["app", "www"] and finds the MOBILE Expo
  // app under ./app (add-mobile-app, 2026-10-10) — whose package.json says
  // main: "expo-router/entry" — then treats it as the desktop app directory
  // and dies in sanityCheckPackage ("Application entry file …/app/expo-router/
  // entry does not exist", release run 38539016384). v1.3.8 shipped before
  // ./app existed, so the collision was latent until the next desktop build.
  directories: { output: "dist", app: "." },
  asar: false,
  // Native addons (better-sqlite3, tree-sitter, fsevents) run under the BUNDLED
  // Node (resources/node), not Electron's Node - so do NOT rebuild them for
  // Electron's ABI. The prebuilt .node files (Node v25 arm64) are used as-is.
  npmRebuild: false,

  files: [
    "server.js",
    "paths.js",
    "*.js",
    // the builder config itself is a build-time input, not app code
    "!electron-builder.js",
    // runtime directories — generated from the single source in
    // scripts/lib/runtime-dirs.mjs (desktop-catch-up-release), so the files
    // list can never silently drop a directory the descriptors/server graph
    // reaches (three shipped instances of exactly that: lib/ 2026-10-07,
    // services/ v1.3.10, agent-runner/ v1.3.13).
    ...RUNTIME_DIRS.map((d) => `${d}/**`),
    // keys.json is gitignored real credentials: the CI checkout never has
    // it, but a LOCAL dist build would leak it.
    "!services/**/keys.json",
    // root runtime data files (bundled market catalog, llm defaults, replay
    // allowlist…). mcp.json/.env stay excluded below as before.
    "*.json",
    "!package-lock.json",
    "!agents.json",
    "!dev-settings.json",
    "platform.bundle.json",
    "electron/**",
    "supervisor/**",
    "bootstrap/**",
    "public/**",
    "web/dist/**",
    "skills/**",
    "mcp.example.json",
    "package.json",
    "node_modules/**",
    // trim node_modules fat (keep native .node binaries + prebuilds)
    "!node_modules/**/{*.md,*.markdown,LICENSE,LICENCE,*.ts,*.map,*.coffee,*.flow}",
    "!node_modules/**/.bin/**",
    "!node_modules/**/test/**",
    "!node_modules/**/tests/**",
    "!node_modules/**/docs/**",
    "!node_modules/**/.github/**",
    // exclude dev-only / non-runtime project content
    "!.claude/**",
    "!.pi/**",
    "!openspec/**",
    "!e2e/**",
    "!playwright.config.js",
    "!test-results/**",
    "!dist/**",
    "!resources/**",
    "!data/**",
    "!sessions-store/**",
    "!chat-history-store/**",
    "!documents-store/**",
    "!collections-store/**",
    "!cron-store/**",
    "!knowledge-store*/**",
    "!.env",
    "!.env.*",
    "!*.log",
    "!.DS_Store",
  ],

  extraResources,
  afterPack,

  mac: {
    category: "public.app-category.developer-tools",
    // Force an arch suffix on every dmg so arm64 + x64 are distinguishable
    // (without this, the x64 dmg is named "Platform-1.0.0.dmg" - ambiguous).
    artifactName: `${productName}-\${version}-\${arch}.\${ext}`,
    target: [
      // No `arch` here: the arch is selected per CI job via `electron-builder
      // --arm64` / `--x64` (a config arch list would make EVERY job build ALL
      // listed archs, ignoring the flag and producing a broken other-arch dmg).
      { target: "dmg" },
    ],
    // Code signing + notarization (see .github/workflows/release.yml):
    //   - Set CSC_LINK / CSC_KEY_PASSWORD env (base64 .p12 + password) to sign
    //     with a Developer ID. Absent -> unsigned build (still succeeds).
    //   - `notarize: true` delegates to @electron/notarize using APPLE_ID /
    //     APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env. electron-builder
    //     SKIPS notarization with a warning when those env vars are absent, so
    //     unsigned CI smoke builds succeed.
    //   - hardenedRuntime is required for notarization; applied during signing
    //     only (no-op for unsigned builds).
    //   - TODO (when certs are provisioned): the bundled standalone Node (V8 JIT)
    //     spawned by the supervisor likely needs entitlements
    //     (com.apple.security.cs.allow-jit / allow-unsigned-executable-memory)
    //     to run under hardened runtime. Unsigned builds are unaffected.
    hardenedRuntime: true,
    notarize: true,
  },

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    legalTrademarks: companyName,
  },

  // Assisted installer (win-install-smoke 2026-10-08 real-device round): the
  // electron-builder NSIS default is oneClick=true — a silent flow with NO
  // directory chooser, NO progress/finish page, and NO cancel button, which
  // read as "stuck on installing" for a ~300MB unpack (asar:false + bundled
  // Node). This is a TOP-LEVEL key (not under `win`: the schema has no `nsis`
  // inside `win`, a misplaced block is silently ignored). assisted installer
  // = the standard wizard: directory picker, progress, finish page.
  // perMachine:false keeps it per-user (no UAC prompt for an unsigned exe).
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    allowElevation: true,
    deleteAppDataOnUninstall: false,
    // Drain-before-swap + uninstall deregistration hooks for the resident
    // steward (add-cell-lifecycle 2.3) — pid-precise, never /IM on node.exe.
    include: "electron/installer.nsh",
  },
};

export default config;
