#!/usr/bin/env node
// Build the open-source snapshot of this private repository.
//
//   node scripts/make-public-snapshot.mjs [--ref HEAD] [--out dist-opensource/platform]
//        [--skip-gitleaks] [--init]
//
// Pipeline:
//   1. Export the committed tree via `git archive <ref>` — gitignored secrets
//      (.env, mcp.json, agents.json, llm-providers.json, .credentials.yaml, …)
//      never enter the snapshot, and neither does uncommitted work.
//   2. Overlay allowlisted working-tree files (README*, LICENSE) so the public
//      docs ship even before the next commit lands them.
//   3. Delete internal-only files/dirs (deploy runbook, cluster manifests,
//      ops tooling, openspec change archives, live-probe scripts, AI-tooling
//      dirs, and this script + its runbook).
//   4. Rewrite internal-infrastructure references in the files that stay.
//      Every scrub is a regex with an expected match count — a refactor that
//      invalidates one fails the build instead of silently shipping a leak.
//   5. Move the tree into dist-opensource/, then verify in place: structural
//      asserts, forbidden-pattern grep over every text file, gitleaks scan.
//      Any finding ⇒ the output is removed and the run exits non-zero.
//
// The output has no git history BY DESIGN: publish it as a NEW public repo.
//
// Before exporting, the guard below refuses an incomplete base: images are cut
// from the operator's HEAD, and twice (2026-11-08) an image shipped missing work
// that only existed on the other remote — once because the checkout was behind
// the other line, once because a merge brought back code the other line had
// deleted. `check-release-lines.mjs` compares the two release lines by patch-id,
// so mirrored commits (same patch, different SHA) never read as a fork.
// Opt out with SNAPSHOT_SKIP_LINE_CHECK=1 when deliberately cutting from a
// non-release ref.
// Full manual runbook (key rotation, repo creation, facade trio):
// docs/opensource-release.md.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const REF = argValue("--ref", "HEAD");
const OUT = resolve(REPO_ROOT, argValue("--out", "dist-opensource/platform"));
const SKIP_GITLEAKS = args.includes("--skip-gitleaks");
// The exact commit the tree is cut from, resolved once — every later message
// (commit body, BUILD-INFO.json) quotes this same sha.
// Keep the remote prefix: `gitee/release/x` is a remote-tracking ref, and
// stripping it to `release/x` resolves to nothing on a machine that has no such
// local branch.
const REF_SHA = execFileSync("git", ["rev-parse", `${REF}^{commit}`], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const DO_INIT = args.includes("--init");

if (!/^[A-Za-z0-9._/-]+$/.test(REF)) {
  console.error(`invalid --ref: ${REF}`);
  process.exit(2);
}

// ─── Base completeness (release lines) ───────────────────────────────────────
// Skipped when the caller exports an arbitrary ref (a docs snapshot from an old
// tag has no business failing on today's line state).
if (!process.env.SNAPSHOT_SKIP_LINE_CHECK && REF === "HEAD") {
  const guard = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-release-lines.mjs")], {
    stdio: "inherit",
  });
  if (guard.status !== 0) {
    console.error(
      "\nBase is not whole: fix the release lines first (see docs/opensource-release.md §2 step 0)," +
        " or export a specific ref with --ref and accept that base.",
    );
    process.exit(guard.status ?? 1);
  }
}
const outRel = relative(REPO_ROOT, OUT);
if (outRel.startsWith("..") || !outRel.startsWith("dist-opensource")) {
  // rm -rf safety: this script only ever replaces paths under dist-opensource/.
  console.error(`--out must live under dist-opensource/ (got ${outRel})`);
  process.exit(2);
}

// ─── Tables ───────────────────────────────────────────────────────────────────

// Working-tree files copied over the archived tree (public docs that may not
// be committed yet). All three are REQUIRED.
const OVERLAY_FILES = ["README.md", "README.zh-CN.md", "LICENSE", ".gitleaks.toml"];

const EXCLUDE_PATHS = new Set([
  // internal docs
  "AGENTS.md", // workspace agent instructions: cluster node names, internal registries, build-pool accounts
  "DEPLOY.md", // live prod runbook: clusters, IPs, registries, jenkins
  "PRODUCT.md", // internal product-strategy doc
  "demands.md", // scratch demand notes
  "lawcraw-architecture.md", // legacy pre-rename product notes
  "docs/opensource-release.md", // this feature's private runbook
  "docs/registry-maintenance.md", // internal registry ops runbook (tailnet/jenkins/ips)
  "docs/supply-store-cutover-runbook.md", // spine cutover ops runbook: fd-infra-deploy paths, cluster node names, gitee remotes (add-supply-store-unification)
  "docs/explore-wanxing-cockpit-projection.md", // internal explore report: cites fd-infra-deploy manifests and internal registry wiring
  "docs/spider-heal-pack.md", // spider-heal pack ops manual (sub2api keys, mesh dsn)
  "facet/cli/NPM-SCOPE-FIX.md", // npm scope ops runbook: account/org internals
  "docs/facet-cutover-repair-handoff.md", // cross-session repair handoff: live host facts, paths, incident log
  "docs/spider-heal-fleet-egress-handoff.md", // spider-heal runner egress handoff: tailnet IPs, cluster names, PAT plumbing
  "docs/pack-source-lineage.md", // pack source-ownership matrix: private repo names (fd-craw-private), gitee wiring, packIds, ops accounts
  "docs/handoff-last-four-steps.md", // cross-session handoff: cites the private repo name (fd-craw-private) and branch/PR plumbing; same class as the three handoffs above
  // internal deploy plumbing
  "Makefile", // k8s/argocd deploy wrapper + prod live-service URL
  "Jenkinsfile",
  ".github/workflows/image.yml", // internal TCR/Harbor image pipeline
  // 供给开放 owner 验收的内部 workflow（312a8a0d）：通篇引用 cheap-8 节点名与
  // 内部车道开关，公开仓跑不了也读不得——同 Makefile/deploy 脚本一类，整体排除。
  ".github/workflows/live-supply-owner-acceptance.yml",
  // The hkccr publish pipeline lives in the paas tree so the verify repo can
  // always re-seed it (d3721f3b), but its internal registry references must
  // never ship — the release flow copies it back in after the export.
  ".github/workflows/image-publish.yml",
  // internal ops artifacts
  "docs/vertical-packs.md", // market-registration runbook (internal registry)
  // yongyi 公开面脱敏善后（820cfc9d）：真源在私有仓，这两份仍带 tailnet/公网 IP
  // 与运维路径，属内部运维文档——与 registry-maintenance 同类，不入公开快照。
  "docs/yongyi-federation-recipe.production.md",
  "docs/yongyi-site-deploy-requirements.md",
  // zhiyu 上线材料（同 yongyi 一类，禁品扫描 2026-10-30 拦下）：DNS A 记录公网 IP、
  // 雷池主机 openssl 取证、私有仓 fd-craw-private 的 codeload 补给单 URL——真源在
  // 私有仓，属内部运维文档，不入公开快照。
  "docs/zhiyu-dns-and-edge-request.md",
  "docs/zhiyu-handoff-note.md",
  "docs/zhiyu-site-deploy-requirements.md",
  "docs/zhiyu-site-supply-order-20261030.md",
  // 素材广场上线材料（add-agent-materials-plaza，2026-11-03 禁品扫描拦下）：雷池
  // 公网 IP、DNSPod 操作细节、generated/snapshot.json 里真实市场邮箱——同 zhiyu/
  // yongyi 一类，真源在私有仓，属内部运维文档与数据产物，不入公开快照。其三支
  // 站点/导出/浏览器测试读 site-plaza/ 或被排除目录（ENOENT 假红），按 c194b58b
  // 「排除而非改他人测试内容」同法随行排除；导出器 scripts/plaza-export.mjs 无
  // 禁品，留在公开树。
  "docs/plaza-explore.md",
  "scripts/deploy-plaza.sh",
  "scripts/test-plaza-site.mjs",
  "scripts/test-plaza-export.mjs",
  "scripts/test-plaza-browser.mjs",
  // internal handoff / acceptance material for add-line-boards-and-action-gate
  // (2026-10-20): live cluster node names, fd-infra-deploy paths, internal TCR
  // URLs, private repo names — same class as the roadmap/handoff exclusions.
  "docs/acceptance-criteria.md",
  "docs/handoff/mcp-tool-scope-2026-10-20.md",
  "docs/pr-wanxing-agent-deploy.md",
  "scripts/deploy-cluster-platform.sh", // internal deploy plumbing (internal TCR URL)
  "scripts/tcr-purge-tags.py", // internal TCR ops: registry hosts + tag policy (2026-10-20)
  // internal ops tool (add-principal-facade 6.1): the facade corpus snapshot
  // reads the internal roadmap doc this script deletes below — it runs on the
  // operator's tree, never in the OSS drop.
  "scripts/facade-corpus-snapshot.mjs",
  // internal wire/lex requirements doc (committed 2026-10-2x): carries live
  // cluster node names — internal planning material, not curated for the drop.
  "docs/wire-lex-credential-ref-and-consent-asset-requirements.md",
  // this tool itself
  "scripts/make-public-snapshot.mjs",
  // desktop in-app update lane (2026-11-02 forbidden-pattern scan hit): the
  // RustFS tailnet URL, hkccr desktop-releases image and cheap-3 sync worker
  // are internal distribution topology — the OSS drop ships the updater core
  // reading DEFAULT_UPDATE_URL from env, not this lane.
  ".github/workflows/release.yml",
  "electron/updater-core.js",
  "scripts/desktop-lane-sync.sh",
  // desktop lane check (2026-11-07 scan hit, harden-desktop-lane-relay): same
  // internal topology — tailnet RustFS + hkccr docker-login line; same class.
  "scripts/desktop-lane-check.sh",
  // desktop release checklist (2026-11-07 scan hit, same change): hkccr push
  // credential naming + tailnet RustFS curl checks — internal ops doc, same
  // class as the lane scripts above.
  "RELEASE_CHECKLIST.md",
  // supply-store skills backfill (2026-11-07 scan hit): internal ops script —
  // names the retired compose Mongo volume/node (cheap-1) as its truth source;
  // spine migration tooling, no product surface, same class as the lane
  // scripts above.
  "scripts/supply-store-skills-backfill.mjs",
  // internal ops test: fleet board URL (tailnet) + jenkins/harbor/argocd state
  "scripts/test-ops-console-board.mjs",
  // internal ops test: fleet-scheduler fixtures carry tailnet IPs and cluster
  // node names (add-fleet-scheduler); same class as the board test above.
  "scripts/test-fleet-scheduler.mjs",
  // internal leak-guard test (add-product-intro-team): its FORBIDDEN list is
  // itself the leak — the regex literals spell out internal repo/credential
  // words so a reader of the public drop could enumerate them. The guard stays
  // in the private repo; shipping it would defeat the scan that caught it.
  "scripts/test-product-intro-seed.mjs",
  // content-baseline tests whose fixtures live under openspec/changes/ (pruned
  // wholesale below): both sides of the comparison are excluded, so the guard
  // is meaningless in the public drop and crashes unit stage with ENOENT.
  // Same class as the official-starter-teams degrade, but these load at module
  // top level with no guard — exclude rather than rewrite others' tests.
  "scripts/test-assistant-packs-content-baseline.mjs",
  "scripts/test-business-teams-content-baseline.mjs",
  "scripts/test-starter-content-baseline.mjs",
  // desktop update-lane test: imports ../electron/updater-core.js which is
  // excluded above — the test only exists where the lane exists.
  "scripts/test-desktop-update.mjs",
  // internal planning docs: 双星伞文档与市场线路线图 carry live-ops facts
  // (cluster node names, law-ai-official relay line, production shas) and
  // change with every internal slice — not curated for the public drop.
  "docs/facet-wanxing-roadmap.md",
  "docs/facet-market-roadmap.md",
  // internal planning doc for the memory + stats plane: cluster node names
  // (cheap-N), production image shas and per-deployment service topology —
  // same class as the roadmaps above, not curated for the public drop.
  "docs/memory-and-stats-plane-explore.md",
  // internal compliance assessment: inventory of internal domains, registry
  // transit route, and cluster node names (合规盘点 v0, 2026-10-13).
  "docs/compliance-opening-assessment.md",
  // ciyuan line deployment payloads: the finddatarouter home-page content
  // archives carry our contact identifiers (personal QQ) — deployed surfaces,
  // not part of the OSS distribution (2026-10-16, forbidden-pattern scan hit).
  "docs/ciyuan/home-content.html",
  "docs/ciyuan/home-content.baseline-2026-10-05.html",
  // 生态调研三份（2026-10-31 曾因禁品扫描排除；2026-11-10 撤除排除）：
  // 排除的理由是文中点名了私有仓，但那三份**早已在公开仓里、且与本地逐字节相同**
  // （实测各命中私有仓名 1 次）——守的是一个已经失守的东西，副作用却是它们被永久冻结：
  // 本脚本是 git init + 单提交的整树替换（见第 668 行），排除的文件下次发布会从公开仓
  // 消失，此后改本地这份公开面不会跟上、也没有任何测试会红。
  // 处置：把三份里的私有仓名改写成「主源码仓（私有）」，语义不变而暴露面比线上现状更小，
  // 然后移出排除，让它们跟随快照正常更新。禁品扫描在下面照常把关。
  // 跨仓注释交付回执（add-mcp-supply-annotations / add-skill-display-annotations，
  // 2026-11-04 禁品扫描拦下）：tailnet IP、cheap-8 节点名、双栈分裂取证——同 yongyi/
  // zhiyu 运维材料一类，真源在私有仓，属内部运维文档，不入公开快照。
  "docs/mcp-annotation-repo-source-receipt.md",
  // 供给域路线图（2026-11-07 禁品扫描拦下）：Studio 迁入挂账段含 cheap-3 旁路
  // 与出片/走查排期，属内部规划文档、非公开交付物，同 registry-maintenance 一类。
  "docs/supply-domain-roadmap.md",
  // 个人代理上产记录（2026-11-10 禁品扫描拦下，3 处）：内部镜像仓（hkccr/ccr 全路径）、
  // gitops 私有仓与其 gitee/main 提交、生产 pod 名与 digest。同上面两条一类：真源在
  // 私有仓，属内部运维文档，不入公开快照。发现方式值得记住——撤掉上面三份生态文档的
  // 排除后重跑本脚本，闸门才把这份挡出来；在此之前**当前 HEAD 根本出不了快照**。
  "docs/deploy-record-personal-agent-2026-11-10.md",
  // 个人代理状态记录（2026-11-10 禁品扫描拦下，1 处）：注入口令那段点名 gitops
  // 私有仓与「envFrom 不热载须 delete pod」的内部操作口径。同上面两条一类。
  // 这是同一类第三次（前面还有 deploy-record 与生态三份）——见交接文档「这一类
  // 会反复咬人」：状态/上产记录天然会写内部路径，作者很难自觉排除。
  "docs/personal-agent-status-2026-11-10.md",
]);
// internal health MCP: README is operator-facing (tailnet mesh IPs, SSRF
// allowlists, DSN handling) — not curated for the public drop (2026-10-06).
// internal fork-patch runbook dir: private repo names, registry lines,
// deploy flow (sub2api 词元谱系, 2026-10-14).
// `evidence/` 是走查截图的本地留档目录（产品 UI 真机图，含设备/账号痕迹）。
// 它本该永不进仓（已写进 .git/info/exclude），但本仓是多会话共用工作树——
// 别人一次 `git add -A` 就足以把它们提交，而下一次快照会把它们推到公开仓。
// 所以在这里再堵一道：进仓也不出仓。
const EXCLUDE_PREFIXES_EXTRA = ["servers/fd-health-mcp/", "docs/sub2api-fork-patches/", "evidence/"];

const EXCLUDE_PREFIXES = [
  // 广场站点生成产物与部署跑本（2026-11-03 禁品扫描拦下：雷池 IP、真实市场邮箱）：
  // 真源私有仓，站点经 rsync 上机、不靠公开快照分发；其测试随 EXCLUDE_PATHS 排除。
  "site-plaza/",
  "k8s/",
  "argocd/",
  "openspec/changes/", // change archives carry live-ops notes (IPs, builds)
  "openspec/specs/ops-console/", // internal operator console capability
  "openspec/specs/live-service-testing/", // probing our live deployment
  "openspec/specs/registry-market-deployment/", // internal market deployment
  "openspec/specs/memory-distiller/", // internal examples carry live cluster node names
  "services/ops-console/", // internal operator dashboard
  "docs/vertical-packs/", // sample pack registration data (Logto org ids)
  ".claude/",
  ".pi/",
  ".impeccable/",
  "docs/adr/", // internal decision records: cluster names, registries, ops
  "docs/registry-fork-patches/", // mcp-gateway fork patch notes (internal)
  "docs/dsh-lock-peer-deadlock.md", // internal handoff: private CI runner repo + TCR secrets
  "docs/queue-backlog-runbook.md", // internal ops runbook: names the private registry + a real outage
  "docs/multi-agent-collaboration-explore.md", // internal defect ledger: private repo names, incident forensics, production coordinates
  "docs/decision-sheet-2026-11-10.md", // internal decision sheet: cell ids, quota figures, budget trade-offs
  "graphify-out/", // generated code-graph artifacts: 115MB of file paths that trip the leak scan; never shipped
];

const EXCLUDE_GLOBS = [
  "HANDOFF-*.md", // cross-session handoffs: live host facts, paths, deploy plumbing
  "scripts/probe-*.mjs", // live probes against company deployments
  "scripts/verify-*live*.mjs", // live verification against company deployments
  "scripts/push_audit_to_wire.py", // internal metering bridge (tailnet fd-wire endpoint)
];

// [file, regex source, replacement, expected count] — applied with flags "g".
// A count mismatch (including 0) on a present file is a hard failure so the
// table cannot rot silently.
const SCRUBS = [
  [".env.example", "\\bDEPLOY\\.md\\b", "the ops runbook", 2],
  [".env.example", "# MC_URL=http://100\\.64\\.0\\.N:3333", "# MC_URL=http://<mission-console-host>:3333", 1],
  [".env.example", "# MC_AGENT_NAME=fd-operator-cell", "# MC_AGENT_NAME=my-operator-cell", 1],
  ["Dockerfile", "harbor\\.local/paas_private/platform", "your-registry/platform", 2],
  [
    "Dockerfile",
    "host \\(Jenkins on cheap-3\\) cannot reach registry-1\\.docker\\.io at all and pulls",
    "host cannot reach registry-1.docker.io and pulls",
    1,
  ],
  [
    "Dockerfile",
    "the cluster's Harbor mirror instead — its Jenkinsfile passes that as",
    "a registry mirror instead — its CI passes that as",
    1,
  ],
  ["Dockerfile", "The China build host \\(Jenkins on cheap-3\\)", "The China build host", 1],
  [
    "Dockerfile",
    'the cheap-1 runner lived "unhealthy" for a generation — 2026-10-07',
    'one runner lived "unhealthy" for a generation',
    1,
  ],
  ["Dockerfile", "DEPLOY\\.md runbook carry the 8790", "ops runbook carries the 8790", 1],
  [
    "agent-runner/manager.js",
    "accumulated evidence on cheap-1: three stale wx dirs",
    "observed in production: three stale wx dirs",
    1,
  ],
  [
    "scripts/release-sync.mjs",
    "production serves /dl/\\* from the platform host via cheap-1 Caddy\\.",
    "production serves /dl/* from the platform host via its edge proxy.",
    1,
  ],
  // Sharded-runner fixtures (add-runner-fleet-sharding, 2026-10-11) use the
  // real node name as a sample runner id — scrub to a neutral id; the test
  // semantics are name-agnostic.
  ["scripts/test-agent-runner.mjs", "cheap-1", "runner-a", 6],
  // Blueprint 走查夹具 (blueprint-studio) 同样把真实节点名当样例 runner——
  // 语义与名字无关，抹成中性 id（与上一条同批，2026-10-28）。
  ["scripts/test-blueprints.mjs", "cheap-1", "runner-a", 2],
  ["scripts/test-blueprint-trial.mjs", "cheap-1", "runner-a", 2],
  ["scripts/test-blueprint-judge.mjs", "cheap-1", "runner-a", 3],
  // Same change: the legacy single-runner seed's default id is a node name in
  // our fleet; a self-hosted install should see a neutral default.
  ["gateway/packs.js", 'AGENT_SERVING_DEFAULT_RUNNER_ID \\|\\| "cheap-1"', 'AGENT_SERVING_DEFAULT_RUNNER_ID || "default-runner"', 1],
  [
    "Dockerfile",
    "is a 4GB machine that ALSO runs the production pod:",
    "is memory-constrained and shares the node with other workloads:",
    1,
  ],
  [
    "Dockerfile",
    "\\(see DEPLOY\\.md → Agent workspace\\)\\.",
    "(operator's responsibility when /data is a host mount).",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "the tailnet IP in",
    "the private-network IP in",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "\\(ccr yizuo/platform:sha-<short>\\)",
    "(the platform image)",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "ccr\\.ccs\\.tencentyun\\.com/yizuo/platform:latest",
    "platform:latest",
    1,
  ],
  ["agent-runner/config.js", "\\(DEPLOY\\.md runbook\\)\\.", "(operator runbook).", 1],
  [
    "agent-runner/index.js",
    "Runbook: DEPLOY\\.md § agent-runner\\.",
    "Runbook: see the agent-runner design (docs/adr/0004).",
    1,
  ],
  ["services/search-relay/index.js", "documented in DEPLOY\\.md", "documented in the ops runbook", 1],
  ["e2e/mc-bridge.spec.js", "see DEPLOY\\.md\\)", "see the ops runbook)", 1],
  ["registry-bridge.js", "recorded in DEPLOY\\.md", "recorded in the ops runbook", 1],
  [
    "dsh-profile.js",
    "// token\\.finddatatech\\.cloud gateway model catalog\\. 2026-09-30 refresh: every id",
    "// Model gateway catalog (2026-09-30 refresh): every id",
    1,
  ],
  ["docs/pack-marketplace.md", "（DEPLOY\\.md §2）", "（运维手册）", 1],
  [
    "gateway/packs.js",
    "https://token\\.finddatatech\\.cloud",
    "https://your-billing-panel.example",
    // 3× since the vendor revenue-share lines (fcc4f020) added a third
    // SUB2API_PANEL_URL fallback beside the two settlement readers.
    3,
  ],
  [
    "gateway/wanxing/index.js",
    "https://token\\.finddatatech\\.cloud",
    "https://your-billing-panel.example",
    1,
  ],
  ["e2e/live-helpers.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 2],
  ["e2e/live.spec.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 1],
  ["playwright.config.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 2],
  ["playwright.config.js", "targets deployed k3s NodePort at", "targets a deployed instance at", 1],
  [
    "docs/spider-heal-pack.md",
    "baseURL `token\\.finddatatech\\.cloud/v1`",
    "baseURL（模型网关，内网）",
    1,
  ],
  [
    "openspec/specs/vertical-packs/spec.md",
    "the OpenAI-compatible endpoint `token\\.finddatatech\\.cloud/v1` \\(model `deepseek-v4-pro`\\)",
    "an OpenAI-compatible endpoint (model `deepseek-v4-pro`)",
    1,
  ],
  // （facet-mcp 免键 clientId 的脱敏条目已摘——测试改为形状+跨目标一致性断言，
  // 字面量不上板，gitleaks 不再命中；facet.js 的 DEFAULT_OAUTH_CLIENT_ID 是
  // 已随 facet 0.3.0 公开发布的 DCR 客户端标识，本身非机密。）
];

// Deliberate exceptions: content that matches a forbidden pattern but is
// itself spec-mandated public surface. A hit is skipped when the offending
// file lives under one of the listed paths.
const ALLOWED = [
  {
    label: "personal identifier",
    paths: ["facet/web/src/PageFooter.tsx", "openspec/specs/facet-platform/spec.md"],
    why: "facet footer contact (email/phone) is mandated by the facet-platform spec and already live on facet.finddatatech.cloud",
  },
  {
    label: "private repo name",
    paths: ["scripts/test-product-intro-seed.mjs"],
    why: "the file's own FORBIDDEN table spells out the very words it scans for (fd-craw-private / registry_token / corpSecret / session-secret), so the regex literals match themselves. The scanned *text* is clean; exempting the table keeps the gate honest instead of teaching people to bypass it.",
  },
];

// Any match in any snapshot text file fails the build. Patterns are
// deliberately specific: public surfaces (www./craw./demo./mcp.
// finddatatech.cloud, WeChat app ids) are allowed on purpose.
const FORBIDDEN = [
  [/100\.64\.\d+\.\d+/, "tailnet IP"],
  [/103\.236\.\d+\.\d+/, "public server IP"],
  [/23\.144\.68\.\d+/, "public server IP"],
  [/cheap-\d/, "cluster node name"],
  [/guangzhou-xinru/, "internal host name"],
  [/harbor\.finddatatech\.cloud/, "internal registry"],
  [/harbor\.local\/paas_private/, "internal registry path"],
  [/hkccr|tencentcontainers|ccr\.cfs/, "internal image registry"],
  [/[Jj]enkins/, "internal CI"],
  // token.finddatatech.cloud reclassified 2026-10-13: it is 萬星·词元's public
  // metering/billing panel (user-facing, login-gated) and appears in the
  // product catalog agents.json; paas-admin stays internal-only.
  [/paas-admin\.finddatatech\.cloud/, "internal-only domain"],
  [/fd-craw-private|fd-infra-deploy/, "private repo name"],
  [/mo2z9kllx2j7|hpe07qejcwk7|sl63fy08ruh9/, "Logto organization id"],
  [/\bDEPLOY\.md\b/, "internal runbook reference"],
  [/1253774197|3106241601/, "personal identifier"],
];

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".woff", ".woff2",
  ".ttf", ".otf", ".gz", ".zip", ".tar", ".node", ".dylib", ".so",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd) {
  return execFileSync("bash", ["-c", cmd], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function globToRegExp(glob) {
  const src = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(glob.includes("**") ? ".*" : "[^/]*");
  return new RegExp(`^${src}$`);
}
const GLOB_RES = EXCLUDE_GLOBS.map(globToRegExp);

function isExcluded(relPath) {
  if (EXCLUDE_PATHS.has(relPath)) return true;
  if (EXCLUDE_PREFIXES.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))) return true;
  if (EXCLUDE_PREFIXES_EXTRA.some((p) => relPath.startsWith(p))) return true;
  if (GLOB_RES.some((re) => re.test(relPath))) return true;
  return false;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isTextFile(path) {
  if (BINARY_EXT.has(path.slice(path.lastIndexOf(".")))) return false;
  const buf = readFileSync(path);
  return !buf.subarray(0, 8000).includes(0);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

// ─── 1. Export the committed tree ─────────────────────────────────────────────

const commit = sh(`git rev-parse --short ${REF}`);
const dirty = sh("git status --porcelain");
if (dirty) {
  console.log(
    `note: working tree is dirty — only OVERLAY_FILES come from the worktree; everything else is ${REF} (${commit}).`,
  );
}

const tmp = mkdtempSync(join(tmpdir(), "paas-oss-"));
try {
  execFileSync("bash", [
    "-c",
    `git -C ${JSON.stringify(REPO_ROOT)} archive --format=tar ${REF} | tar -x -C ${JSON.stringify(tmp)}`,
  ]);
  console.log(`exported ${REF} (${commit})`);

  // ─── 2. Overlay public docs from the working tree ───────────────────────────

  for (const f of OVERLAY_FILES) {
    const src = join(REPO_ROOT, f);
    if (!existsSync(src)) fail(`overlay file missing in working tree: ${f}`);
    copyFileSync(src, join(tmp, f));
    console.log(`overlay  ${f}`);
  }

  // ─── 3. Exclusions ──────────────────────────────────────────────────────────

  let excluded = 0;
  for (const full of [...walk(tmp)]) {
    if (isExcluded(relative(tmp, full))) {
      rmSync(full);
      excluded++;
    }
  }
  // Prune directories left empty by the exclusions (git archive materializes
  // them; structural asserts require the dirs themselves to be gone).
  const pruneEmpty = (dir) => {
    let empty = true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!pruneEmpty(full)) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== tmp) rmdirSync(dir);
    return empty;
  };
  pruneEmpty(tmp);
  console.log(`excluded ${excluded} internal file(s)`);

  // ─── 4. Scrubs ──────────────────────────────────────────────────────────────

  let scrubbed = 0;
  for (const [file, find, replace, expect] of SCRUBS) {
    const full = join(tmp, file);
    if (!existsSync(full)) continue; // excluded upstream; asserts below guard structure
    const before = readFileSync(full, "utf8");
    const re = new RegExp(find, "g");
    const count = (before.match(re) || []).length;
    if (count !== expect) {
      fail(`scrub rot in ${file}: pattern matched ${count}×, expected ${expect}× — update the SCRUBS table: ${find}`);
    }
    writeFileSync(full, before.replace(re, replace));
    scrubbed++;
  }
  console.log(`scrubbed ${scrubbed}/${SCRUBS.length} file(s)`);

  // ─── 5. Move into place, then verify ────────────────────────────────────────

  mkdirSync(join(OUT, ".."), { recursive: true });
  rmSync(OUT, { recursive: true, force: true });
  cpSync(tmp, OUT, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  // Build provenance, inside the image: the tag alone cannot say WHICH base a
  // published image was cut from (2026-11-08: an image claimed paas 53be7fbbe in
  // the manifest comment while its tree carried neither the v100 migration guard
  // nor the uninstall ledger deprecation). This file is the only in-image answer,
  // so a rollout can be verified against the claim instead of trusted.
  writeFileSync(
    join(OUT, "BUILD-INFO.json"),
    `${JSON.stringify(
      {
        baseRef: REF,
        baseCommit: REF_SHA,
        snapshotCommit: "filled in by the publish repo's own commit",
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`placed   ${relative(REPO_ROOT, OUT)}/  (BUILD-INFO.json: ${REF} ${REF_SHA.slice(0, 9)})`);

  const structural = [
    [existsSync(join(OUT, "README.md")), "README.md present"],
    [existsSync(join(OUT, "README.zh-CN.md")), "README.zh-CN.md present"],
    [existsSync(join(OUT, "LICENSE")), "LICENSE present"],
    [!existsSync(join(OUT, "DEPLOY.md")), "DEPLOY.md absent"],
    [!existsSync(join(OUT, "openspec/changes")), "openspec/changes/ absent"],
    [!existsSync(join(OUT, "Jenkinsfile")), "Jenkinsfile absent"],
    [!existsSync(join(OUT, "k8s")), "k8s/ absent"],
    [
      readFileSync(join(OUT, "README.md"), "utf8").includes("/products/base") &&
        readFileSync(join(OUT, "README.md"), "utf8").includes("README.zh-CN.md"),
      "README.md: base-line banner + zh interlink",
    ],
    [
      readFileSync(join(OUT, "README.zh-CN.md"), "utf8").includes("/products/base") &&
        readFileSync(join(OUT, "README.zh-CN.md"), "utf8").includes("](README.md)"),
      "README.zh-CN.md: base-line banner + en interlink",
    ],
  ];
  for (const [ok, label] of structural) {
    if (!ok) fail(`structural check failed: ${label}`);
    console.log(`assert   ✓ ${label}`);
  }

  const hits = [];
  let textFiles = 0;
  for (const full of walk(OUT)) {
    if (!isTextFile(full)) continue;
    textFiles++;
    const rel = relative(OUT, full);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [re, label] of FORBIDDEN) {
        if (!re.test(line)) continue;
        const allow = ALLOWED.find((a) => a.label === label && a.paths.some((p) => rel === p || rel.startsWith(p)));
        if (allow) continue;
        hits.push(`${rel}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
      }
    });
  }
  if (hits.length) {
    console.error(`\n✗ forbidden patterns found (${hits.length}):`);
    for (const h of hits) console.error(`  ${h}`);
    fail("scrub or exclude the files above, then re-run");
  }
  console.log(`scan     ✓ no forbidden patterns across ${textFiles} text files`);

  if (!SKIP_GITLEAKS) {
    const cfg = ["--config", join(OUT, ".gitleaks.toml")];
    let res = spawnSync("gitleaks", ["dir", OUT, ...cfg, "--no-banner", "--redact"], { encoding: "utf8" });
    if (/unknown command/i.test(res.stderr || "")) {
      res = spawnSync(
        "gitleaks",
        ["detect", "--no-git", "--source", OUT, ...cfg, "--no-banner", "--redact"],
        { encoding: "utf8" },
      );
    }
    if (res.error) {
      fail(`gitleaks unavailable (${res.error.code}) — brew install gitleaks, or pass --skip-gitleaks`);
    }
    if (res.status !== 0) {
      console.error(res.stdout || res.stderr);
      fail("gitleaks reported findings in the snapshot");
    }
    console.log("gitleaks  ✓ clean");
  }

  // ─── 6. Optional: make it a push-ready git repo ─────────────────────────────

  if (DO_INIT) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: OUT });
    execFileSync("git", ["add", "-A"], { cwd: OUT });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Platform Release",
        "-c",
        "user.email=release@localhost",
        "commit",
        "-q",
        "-m",
        `Platform v1.3.0 — initial open-source release (snapshot of ${REF} ${commit})`,
      ],
      { cwd: OUT },
    );
    console.log("git      ✓ initialized, single release commit");
  }

  console.log(
    `\n✓ snapshot ready: ${OUT}\n  next: follow docs/opensource-release.md §发布.`,
  );
} catch (err) {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
