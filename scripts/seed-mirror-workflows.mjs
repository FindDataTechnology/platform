#!/usr/bin/env node
// ── Seed the mirror-only workflows before a snapshot is pushed ───────────────
// (openspec: seed-mirror-workflows; release-line-hygiene)
//
// One tree, two destinations, one exclusion list. `make-public-snapshot.mjs`
// deliberately keeps `.github/workflows/image-publish.yml` OUT of the public
// snapshot (it names the internal registry topology) — right for the open-source
// release repository, wrong for the image mirror, which is force-pushed the
// SAME tree and needs exactly that file to publish anything at all.
//
// A force push turns "absent from the snapshot" into "deleted on the target",
// and the symptom does not look like a deletion: the push succeeds, runs
// appear, `image-build-check` goes green, and no tag is ever produced. Lost
// three times (2026-10-11, 2026-11-11, 2026-11-13). The third time was
// *made of memory* — I confirmed the snapshot lacked the file and concluded,
// backwards, that the mirror's copy would therefore survive. Memory is the
// wrong storage for a step whose omission is silent: this is the step.
//
// Usage:
//   node scripts/seed-mirror-workflows.mjs <dist-dir>      # e.g. dist-opensource/platform
//   node scripts/seed-mirror-workflows.mjs --list          # show what would be seeded
// Exit: 0 every listed workflow present and identical; 1 anything else (paths named).

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The mirror's publish path. Deliberately a literal list rather than "every
// excluded workflow": only this one is *required* by a destination, and a
// broad rule would quietly re-publish things the exclusion list protects.
export const MIRROR_ONLY_WORKFLOWS = [".github/workflows/image-publish.yml"];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Copy (or verify) each listed workflow into `distDir`. Pure enough to test:
// takes both roots and the list, returns a receipt instead of printing.
//   { ok, seeded: [...], already: [...], errors: [{ path, reason }] }
export function seedMirrorWorkflows({ repoRoot = REPO_ROOT, distDir, files = MIRROR_ONLY_WORKFLOWS } = {}) {
  const receipt = { ok: true, seeded: [], already: [], errors: [] };
  if (!distDir) {
    receipt.ok = false;
    receipt.errors.push({ path: "<dist-dir>", reason: "missing_argument" });
    return receipt;
  }

  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(distDir, rel);
    let wanted;
    try {
      wanted = readFileSync(src);
    } catch (e) {
      receipt.ok = false;
      receipt.errors.push({ path: rel, reason: `source_unreadable:${e.code ?? e.message}` });
      continue;
    }

    let current = null;
    try {
      current = readFileSync(dest);
    } catch {
      /* absent is the case this step exists for */
    }
    if (current !== null && Buffer.compare(current, wanted) === 0) {
      receipt.already.push(rel);
      continue;
    }

    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      // copyFileSync preserves bytes; a rewrite through strings could reorder
      // line endings and turn a no-op into a diff.
      copyFileSync(src, dest);
    } catch (e) {
      receipt.ok = false;
      receipt.errors.push({ path: rel, reason: `write_failed:${e.code ?? e.message}` });
      continue;
    }

    // Re-read: "I copied it" is not evidence that it is there.
    try {
      const after = readFileSync(dest);
      if (Buffer.compare(after, wanted) !== 0) {
        receipt.ok = false;
        receipt.errors.push({ path: rel, reason: "mismatch_after_copy" });
        continue;
      }
    } catch (e) {
      receipt.ok = false;
      receipt.errors.push({ path: rel, reason: `missing_after_copy:${e.code ?? e.message}` });
      continue;
    }
    receipt.seeded.push(rel);
  }
  return receipt;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const f of MIRROR_ONLY_WORKFLOWS) console.log(f);
    process.exit(0);
  }
  const distDir = args.find((a) => !a.startsWith("--"));
  const r = seedMirrorWorkflows({ distDir });
  for (const f of r.seeded) console.log(`seeded   ${f}`);
  for (const f of r.already) console.log(`already  ${f} (identical — untouched)`);
  for (const e of r.errors) console.error(`ERROR    ${e.path}: ${e.reason}`);
  if (!r.ok) {
    console.error(`
[seed-mirror-workflows] 快照树不完整，别推镜像仓：
  · 上面的路径是缺的那份（或写不进去）；
  · 推之前必须补齐——否则 force push 会把镜像仓上的同名文件**删掉**，
    image-build-check 照样绿，但永远不出片（已发生三次）。
`);
    process.exit(1);
  }
  console.log(`
[seed-mirror-workflows] ✓ 镜像仓需要的工作流已在快照树里。
  下一步（在快照目录里）：
    git add .github/workflows && git commit -m "ci(mirror): seed publish workflow" || true
    git push --force mirror main
  推完判据三条缺一不可：gh workflow list 里有 image → gh run list 出现 image → relay 日志有 OK 行。
`);
}
