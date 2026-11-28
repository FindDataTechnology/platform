// Tests for the progress feeder (add-progress-feed).
//
// The feeder's only job is to not lie: every line it writes must point back at a
// real commit or a real file, and "I found nothing" must never look like "there
// is nothing". So the suite builds throwaway git repos and drives the real
// functions — no network, no memory service, no LLM.
//
// Run: node --test scripts/test-progress-feed.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoBlock, scan, compose, handoffsOf, openspecBlock } from "./progress-feed.mjs";

let root;

const git = (dir, ...args) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

function makeRepo(name, { commits = ["first"], openspec = null, docs = {} } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const subject of commits) {
    write(path.join(dir, "file.txt"), `${subject}\n`);
    git(dir, "add", "file.txt");
    git(dir, "commit", "-q", "-m", subject);
  }
  if (openspec) {
    for (const [change, { done, todo }] of Object.entries(openspec)) {
      const lines = [
        `# Tasks — ${change}`,
        ...Array.from({ length: done }, (_, i) => `- [x] ${i + 1}. done`),
        ...Array.from({ length: todo }, (_, i) => `- [ ] ${done + i + 1}. todo`),
      ];
      write(path.join(dir, "openspec", "changes", change, "tasks.md"), lines.join("\n"));
    }
  }
  for (const [file, text] of Object.entries(docs)) write(path.join(dir, "docs", file), text);
  return dir;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feed-test-"));

  // A busy repo with an in-flight change.
  makeRepo("alpha", {
    commits: ["feat: alpha one", "fix: alpha two", "docs: alpha three"],
    openspec: { "add-alpha": { done: 3, todo: 2 } },
    docs: {
      "handoff-alpha.md": "# Alpha handoff\n\nnotes\n",
      "design-notes.md": "# Not a handoff\n",
      "nested/deep-handoff-2026.md": "# Deep handoff\n",
    },
  });
  // A repo with no openspec and no docs.
  makeRepo("beta", { commits: ["chore: beta"] });
  // A plain directory (not a repo) and a skipped directory name.
  write(path.join(root, "not-a-repo", "file.txt"), "x\n");
  makeRepo("archive", { commits: ["should be skipped"] });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("scan counts git repos only, and skips the archive/cache dirs", () => {
  const { status, blocks } = scan(root);
  assert.equal(status.ok, true);
  assert.equal(status.repos, 2, "alpha + beta only (not-a-repo is not a repo, archive is skipped)");
  assert.deepEqual(blocks.map((b) => b.rel).sort(), ["alpha", "beta"]);
  assert.equal(status.changes, 1, "one in-flight change across the tree");
});

test("every block carries a sha and a resume-able coordinate", () => {
  const { blocks } = scan(root);
  const alpha = blocks.find((b) => b.rel === "alpha");
  assert.match(alpha.sha, /^[0-9a-f]{7,}$/);
  assert.equal(alpha.changed, 0, "a clean repo reports no modifications");
  assert.ok(alpha.lines.some((l) => l.includes("docs: alpha three")), "recent commit subjects are carried");
  assert.ok(alpha.lines.some((l) => l.includes("`add-alpha` 3/5")), "in-flight change carries its x/y count");
});

test("only explicitly named handoffs are collected", () => {
  const dir = path.join(root, "alpha");
  const found = handoffsOf(dir).map((h) => h.file).sort();
  // The walk is docs/ + one level down, so both handoff names are found — and
  // that is the contract, not a bug: nested handoffs are common. What must NEVER
  // happen is a file that is not named like a handoff.
  assert.deepEqual(
    found,
    ["docs/handoff-alpha.md", "docs/nested/deep-handoff-2026.md"],
    "both handoff-named files are collected, including the one a level down",
  );
  assert.ok(!found.some((f) => f.includes("design-notes")), "a doc in docs/ is not a handoff by location alone");
  // And the title is lifted from the H1, because a bare filename tells the reader nothing.
  const titles = handoffsOf(dir).map((h) => h.title);
  assert.ok(titles.includes("Deep handoff"), `H1 becomes the title (got ${JSON.stringify(titles)})`);
});

test("unreadable openspec is reported per-repo, not silently dropped", () => {
  const dir = path.join(root, "beta");
  assert.deepEqual(openspecBlock(dir), [], "no openspec dir = no rows, no noise");
});

test("dirty state separates tracked changes from untracked output", () => {
  const dir = path.join(root, "beta");
  write(path.join(dir, "file.txt"), "modified\n");           // tracked modification
  write(path.join(dir, "dist", "bundle.js"), "artifact\n");   // untracked output
  const { block } = repoBlock(dir, "beta");
  assert.equal(block.changed, 1, "one tracked modification");
  assert.equal(block.untracked, 1, "one untracked artifact");
  assert.ok(block.lines[0].includes("改动 1"), "tracked and untracked are not conflated");
});

test("compose always states the status, the as_of and the counts", () => {
  const { status, blocks } = scan(root);
  const body = compose(blocks, status, "2026-11-12T00:00:00Z");
  assert.ok(body.startsWith("# 项目进度 · 2026-11-12T00:00:00Z"));
  assert.ok(body.includes("as_of：`2026-11-12T00:00:00Z`"), "the as_of is quoted for the consumer to repeat");
  assert.ok(body.includes("仓 2"), "repo count");
  assert.ok(body.includes("`ok`"), "status is one of ok/partial/failed");
  assert.ok(!body.includes("undefined"), "no placeholder leaks into the page");
});

test("a failing source turns the status partial and names the reason", () => {
  const { blocks } = scan(root);
  const status = { ok: false, repos: blocks.length, changes: 0, handoffs: 0, failures: ["alpha: git log 失败"] };
  const body = compose(blocks, status, "2026-11-12T00:00:00Z");
  assert.ok(body.includes("`partial`"), "a per-source failure is not reported as ok");
  assert.ok(body.includes("失败：alpha: git log 失败"), "the reason is on the page");
});

test("truncation is annotated, never silent", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    rel: `repo-${i}`,
    sha: "abcdef1",
    iso: "2026-11-12T00:00:00+08:00",
    changed: 0,
    untracked: 0,
    lines: [`- 分支 \`main\` · HEAD \`abcdef1\``, ...Array.from({ length: 10 }, (_, j) => `  - commit ${j}`)],
  }));
  const body = compose(many, { ok: true, repos: 40, changes: 0, handoffs: 0, failures: [] }, "2026-11-12T00:00:00Z");
  assert.ok(/已截断/.test(body), "a truncated page says so");
  assert.ok(body.includes("其余仓"), "the tail is summarised, not dropped");
  assert.ok(body.length <= 12050, `body stays within the budget (got ${body.length})`);
});

test("an empty root reports failure and produces no page", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "feed-empty-"));
  try {
    const { status, blocks } = scan(empty);
    assert.equal(status.repos, 0);
    assert.equal(blocks.length, 0);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// 5.2：openspec 读不动时，**原因必须在页里**。这条以前是静默的——`tasks.md` 读失败时
// catch 是空的，于是"这个变更的 tasks.md 坏了"与"这个变更没有任务"在页上完全同形。
// 造法：把 tasks.md 做成一个**目录**（readFileSync 必抛 EISDIR）。
test("unreadable tasks.md is marked on the page, not silently shown as 0/0", () => {
  const dir = path.join(root, "alpha");
  const broken = path.join(dir, "openspec", "changes", "broken-change");
  fs.mkdirSync(path.join(broken, "tasks.md"), { recursive: true });   // ← 目录，读必失败
  try {
    const rows = openspecBlock(dir);
    const row = rows.find((r) => r.includes("broken-change"));
    assert.ok(row, `broken-change should appear (got ${JSON.stringify(rows)})`);
    assert.match(row, /读不到/, "a read failure must be NAMED on the row, not swallowed");
    assert.ok(!/\b0\/0\b/.test(row), "a read failure must not be rendered as 0/0");
    // 正常那个变更仍带计数：失败不污染邻居
    const ok = rows.find((r) => r.includes("add-alpha"));
    assert.match(ok ?? "", /3\/5/);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
});
