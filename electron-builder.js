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

import { existsSync } from "node:fs";

const productName = (process.env.PRODUCT_NAME || "").trim() || "Platform";
const icon = existsSync("build/icon.downloaded.png") ? "build/icon.downloaded.png" : "build/icon.png";
const companyName = (process.env.COMPANY_NAME || "").trim() || undefined;

/** @type {import('electron-builder').Configuration['extraResources']} */
const extraResources = [
  {
    from: "resources/node/",
    to: "node/",
    filter: ["**/*", "!*.tar.gz"],
  },
  {
    // dsh's runtime components live in its NESTED node_modules (172 packages:
    // dsh-* / cordis-plugin-* / dsh-sdk-jsonrpc-server, loaded dynamically by
    // the profile boot and the platform bridge plugins). The builder's node-
    // modules collector only walks DECLARED dependency edges (npm list prod
    // graph), so peer-only and dynamically-inserted components never reach
    // the packed tree — v1.3.2/v1.3.3/v1.3.4 win-install-smoke all died on
    // the first missing component (cordis-plugin-group). extraResources
    // copies LITERALLY, bypassing the collector: ship the nested tree intact
    // so the packaged dsh resolves components exactly like a dev tree.
    from: "node_modules/@deepseek-ai/dsh/node_modules/",
    to: "app/node_modules/@deepseek-ai/dsh/node_modules/",
    filter: ["**/*", "!**/.bin/**", "!**/.DS_Store"],
  },
];

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: "com.earendil.platform",
  productName,
  icon,
  directories: { output: "dist" },
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
    // runtime subdirs server.js imports (2026-10-07 desktop smoke: a missing
    // lib/ made every packaged app die on ERR_MODULE_NOT_FOUND at boot)
    "lib/**",
    "server/**",
    "gateway/**",
    // dsh profile scaffold + bridge plugin, materialized at runtime
    "dsh-profile-template/**",
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
    // dsh ships its runtime components as NESTED dependencies inside its own
    // node_modules (170+ dsh-* / cordis-plugin-* packages, loaded dynamically
    // by the profile boot — not statically importable, so the builder's
    // production-closure walk misses them; win-install-smoke 2026-10-08:
    // packaged dsh died on the first missing cordis-plugin-group). The glob
    // above should already match them (negations below do not exclude them),
    // but nested scopes have historically been dropped by builder versions —
    // keep this explicit restatement so the dsh runtime can never silently
    // half-ship.
    "node_modules/@deepseek-ai/dsh/node_modules/**",
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

  mac: {
    category: "public.app-category.developer-tools",
    // Force an arch suffix on every dmg so arm64 + x64 are distinguishable
    // (without this, the x64 dmg is named "Platform-1.0.0.dmg" - ambiguous).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder substitutes ${version}/${arch}/${ext} itself — this is not a JS template
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
  },
};

export default config;
