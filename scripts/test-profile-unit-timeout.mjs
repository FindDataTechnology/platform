#!/usr/bin/env node
// ── The profiler must survive a hung file, and must not call it a failure ────
//
// `profile-unit.mjs` ran `execFileSync(process.execPath, ["--test", file])` with
// no `timeout`. Measured 2026-11-16: `test-cell-gateway.mjs` sat 7 minutes with
// nothing printed, and the only way to learn which file was stuck was
// `ps -Ao etime,args`. A leaderboard tool that can be stalled forever by one
// file is unusable exactly when it is most needed (when something hangs).
//
// Three properties, each of which fails independently:
//   1. a hung file is cut off at the budget and the run CONTINUES;
//   2. a timeout is reported as `TIMEOUT`, not as `FAIL` — "did not finish in
//      the budget" and "ran and failed" have different follow-ups;
//   3. the hung file's own child process does not survive the kill (`node --test`
//      forks the file, so killing only the direct child leaves it burning CPU).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "profile-unit.mjs");
// The budget must clear `node --test`'s own boot, or the quick file gets cut too
// and the case stops proving anything: at 1s BOTH fixtures came back TIMEOUT (a
// true statement about that budget, and a useless test of the classification).
// Measured cost of boot+wrapper on a loaded 8-core box: 1s bare, up to ~4s once
// `/usr/bin/time` wraps the run — so the budget has to clear ~4s with margin.
const BUDGET_MS = 10_000;

/** A fake checkout: real `node_modules` DIRECTORY (the profiler refuses symlinks). */
function fixture() {
  const root = path.join(os.tmpdir(), `prof-fixture-${process.pid}-${Date.now()}`);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "test-hangs.mjs"),
    `import test from "node:test";
test("hangs forever", async () => {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
});
`,
  );
  writeFileSync(
    path.join(root, "scripts", "test-quick.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
test("quick", () => assert.equal(1 + 1, 2));
`,
  );
  return root;
}

/**
 * The env for a nested profiler run. `NODE_TEST_CONTEXT` is deleted because the
 * outer `node --test` sets it, and an inner `node --test` that inherits it lands
 * in "child of a test run" mode — a failing fixture file then exits 0 and the
 * classification under test never happens (measured: the broken file reported
 * `ok 1917ms` under the runner and `FAIL 13647ms` when run by hand).
 */
function profilerEnv(root, budgetMs) {
  const env = { ...process.env, PROFILE_UNIT_ROOT: root, PROFILE_UNIT_TIMEOUT_MS: String(budgetMs) };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function run(files, budgetMs = BUDGET_MS) {
  const root = fixture();
  const started = Date.now();
  const res = spawnSync(process.execPath, [PROFILE, ...files], {
    env: profilerEnv(root, budgetMs),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { root, res, elapsed: Date.now() - started };
}

test("挂住的文件在预算处被切断，整榜继续跑完（不是永久卡死）", () => {
  const { res, elapsed } = run(["scripts/test-hangs.mjs", "scripts/test-quick.mjs"]);
  assert.equal(res.status, 0, `profiler 自己不该失败：${res.stderr}`);
  // 预算 1s ＋ 一个快文件；给足余量但仍远小于「卡死」
  assert.ok(elapsed < 30_000, `跑了 ${elapsed}ms —— 看起来仍然会卡死`);
  assert.match(res.stdout, /TIMEOUT\s+cpu\s+[\d.—]+s\s+wall\s+\d+ms\s+scripts\/test-hangs\.mjs/);
  // 关键：卡住之后的那一个文件仍然被跑了（切断不等于放弃整轮）
  assert.match(res.stdout, /ok\s+cpu\s+[\d.—]+s\s+wall\s+\d+ms\s+scripts\/test-quick\.mjs/, "超时后没继续跑下一个文件");
});

test("超时与失败分开报：汇总里 timeout 1 / fail 0", () => {
  const { res } = run(["scripts/test-hangs.mjs", "scripts/test-quick.mjs"]);
  const summary = res.stdout.split("\n").find((l) => l.includes("total wall")) ?? "";
  assert.match(summary, /ok 1 \/ fail 0 \/ timeout 1/, `汇总不诚实：${summary}`);
  assert.match(res.stdout, /耗时只能给下界/);
});

test("真失败仍报 FAILED，不被算成超时（两档判据不能互换）", () => {
  // A generous budget on purpose: `node --test` boot alone measured ~1s here, so
  // a tight budget would kill the failing file and we would be asserting the
  // timeout path while believing we were testing the failure path.
  const root = fixture();
  writeFileSync(
    path.join(root, "scripts", "test-broken.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
test("broken", () => assert.equal(1, 2));
`,
  );
  const res = spawnSync(process.execPath, [PROFILE, "scripts/test-broken.mjs"], {
    env: profilerEnv(root, 60_000),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.match(res.stdout, /FAIL\s+cpu\s+[\d.—]+s\s+wall\s+\d+ms\s+scripts\/test-broken\.mjs/);
  assert.doesNotMatch(res.stdout, /TIMEOUT\s+cpu\s+[\d.—]+s\s+wall\s+\d+ms\s+scripts\/test-broken\.mjs/);
  assert.match(res.stdout, /ok 0 \/ fail 1 \/ timeout 0/);
});

test("被切断的文件不留孙进程（`node --test <file>` 会 fork，只杀父进程等于没杀）", () => {
  const { root } = run(["scripts/test-hangs.mjs"]);
  // Give the group kill a moment, then look for any process still naming the fixture.
  const ps = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8" });
  const survivors = ps
    .split("\n")
    .filter((line) => line.includes(root) && line.includes("test-hangs.mjs"));
  assert.deepEqual(survivors, [], `超时后仍有进程在跑：\n${survivors.join("\n")}`);
});

// ── CPU seconds: the number that survives a busy machine ────────────────────
//
// Wall clock cannot rank files on a box somebody else is using — the reason this
// leaderboard kept coming back "判不出": the same file measured 34.5s and 37.9s
// at load 6.6→7.5. CPU (user+sys of the child tree) separates "burns CPU" from
// "waits", which is the distinction the leaderboard exists to make, so it has to
// be pinned rather than assumed.

test("CPU 把「烧 CPU」和「在等」分开（墙钟分不开：负载把两者的墙一起吹大）", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "scripts", "test-spins.mjs"),
    `import test from "node:test";
test("burns", () => { const end = Date.now() + 1500; while (Date.now() < end) {} });
`,
  );
  writeFileSync(
    path.join(root, "scripts", "test-waits.mjs"),
    `import test from "node:test";
test("waits", async () => { await new Promise((r) => setTimeout(r, 1500)); });
`,
  );
  const res = spawnSync(process.execPath, [PROFILE, "scripts/test-spins.mjs", "scripts/test-waits.mjs"], {
    env: profilerEnv(root, 60_000),
    encoding: "utf8",
    timeout: 180_000,
  });
  const cpuOf = (name) => {
    const line = res.stdout.split("\n").find((l) => l.includes(name)) ?? "";
    const m = line.match(/cpu\s+([\d.]+)s/);
    return m ? Number(m[1]) : null;
  };
  const spins = cpuOf("test-spins.mjs");
  const waits = cpuOf("test-waits.mjs");
  assert.ok(spins !== null && waits !== null, `没量到 CPU 列：\n${res.stdout}`);
  // 判据是「两者分开」，不是绝对值：忙等 1.5s 在严重饿着的机器上也会烧不满 1.5s
  // CPU（跑满六条臂时实测就是这样红的），所以门槛只用来排除「根本没量到」。
  assert.ok(spins >= 0.3, `自旋文件的 CPU 只有 ${spins}s —— CPU 列没在量整棵子进程树`);
  assert.ok(waits < spins, `等待(${waits}s) 与自旋(${spins}s) 的 CPU 没分开 ⇒ 排名会退回墙钟`);
});

test("量不到 CPU 时明说并按墙钟排（静默回退＝把噪声当信号）", () => {
  const root = fixture();
  const res = spawnSync(process.execPath, [PROFILE, "scripts/test-quick.mjs"], {
    env: { ...profilerEnv(root, 60_000), PROFILE_UNIT_CPU: "0" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.match(res.stdout, /ranking by wall clock, which is load-sensitive/, `降级没说出来：\n${res.stdout}`);
  assert.match(res.stdout, /ok\s+cpu\s+—s\s+wall\s+\d+ms/, "缺 CPU 时那一列应留占位");
  // 没有 CPU 就没有「等待放大」这一视图 —— 断言它缺席，而不是断一个已经改名的旧标题
  assert.doesNotMatch(res.stdout, /等待放大最多/, "没有 CPU 却还出等待放大榜");
  assert.match(res.stdout, /最贵（按墙钟/, "墙钟那一视图必须仍在（它是主榜）");
});

// ── JOBS: the shape CI actually runs ────────────────────────────────────────
//
// Serially 76 files cost ~2h on the reference box, which is why the full
// leaderboard kept not happening. CI runs `node --test` over files in parallel,
// so the serial wall clock is a number nobody pays. The risk pinned here is
// specific: with several files in flight, one SHARED `/usr/bin/time -o` path
// hands every row whichever numbers landed last — two plausible-looking CPU
// values that are simply wrong, and the ranking built on them with them.

test("并行档：两个文件同时跑，两行都在且 CPU 各自独立（不共用一份报告）", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "scripts", "test-spin-a.mjs"),
    `import test from "node:test";
test("burns a", () => { const end = Date.now() + 1200; while (Date.now() < end) {} });
`,
  );
  writeFileSync(
    path.join(root, "scripts", "test-spin-b.mjs"),
    `import test from "node:test";
test("burns b", () => { const end = Date.now() + 1200; while (Date.now() < end) {} });
`,
  );
  const res = spawnSync(
    process.execPath,
    [PROFILE, "scripts/test-spin-a.mjs", "scripts/test-spin-b.mjs", "scripts/test-quick.mjs"],
    {
      env: { ...profilerEnv(root, 60_000), PROFILE_UNIT_JOBS: "2" },
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(res.status, 0, `profiler 自己不该失败：${res.stderr}`);
  assert.match(res.stdout, /2 at a time/, `没说是并行档：\n${res.stdout}`);
  for (const f of ["test-spin-a.mjs", "test-spin-b.mjs", "test-quick.mjs"]) {
    assert.match(
      res.stdout,
      new RegExp(`ok\\s+cpu\\s+[\\d.]+s\\s+wall\\s+\\d+ms\\s+scripts/${f}`),
      `${f} 没有独立的一行：\n${res.stdout}`,
    );
  }
  // 两个自旋文件同时跑，各自的 CPU 都必须量到（≥0.3s 只用来排除「根本没量到」：
  // 满载机上忙等会被饿）。共用一份报告时后完成的那个会读到前一个的数字，
  // 于是「两个都 independent」这条会以不可预测的方式红。
  const cpus = [...res.stdout.matchAll(/ok\s+cpu\s+([\d.]+)s\s+wall\s+\d+ms\s+scripts\/test-spin-/g)].map((m) => Number(m[1]));
  assert.equal(cpus.length, 2, `没量到两个自旋文件的 CPU：\n${res.stdout}`);
  assert.ok(cpus.every((c) => c >= 0.3), `并行时 CPU 列没各自量：${cpus.join(" / ")}`);
  assert.match(res.stdout, /total wall [\d.]+s \(2 in flight\)/, "汇总没标注并行档");
});
