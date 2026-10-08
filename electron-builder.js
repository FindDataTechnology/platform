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
};

export default config;
