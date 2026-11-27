// ── 未归类筛选项（polish-facet-read-surfaces 4.1）─────────────────────────────
//
// 市场今天只给 50 条、且 22 个包不属于任何已声明的线 —— 它们在「全部」下可见，
// 但任何一种线级筛选都筛不到，等于没有入口。这个筛选项就是那个入口。
//
// 这里钉住的是**同一个数**：筛选项的计数 = 总数 − 各线计数之和，而筛选结果
// 恰好是那个集合。两处都读同一张 categoryLines 表，所以不会漂移。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "unlined-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const mk = (name, extra = {}) => ({
  name,
  description: "d",
  skills: [{ name: `s-${name}`, description: "d", content: "c" }],
  ...extra,
});

test("unlined filter returns exactly the packs no line chip can reach", async () => {
  const { createPackRegistry } = await import("../gateway/packs.js");
  const reg = createPackRegistry({ file: join(dir, "p.db") });
  reg.publish({ email: "a@x", manifest: mk("legal-pack", { category: "legal" }) });
  reg.publish({ email: "a@x", manifest: mk("fleet-pack", { category: "fleet" }) });
  reg.publish({ email: "a@x", manifest: mk("company-pack", { category: "company" }) });
  reg.publish({ email: "a@x", manifest: mk("nocat-pack") });

  const all = reg.list({ viewer: { email: "" } });
  const unl = reg.list({ viewer: { email: "" }, unlined: true });
  const sumLines = reg.facets({ locale: "zh" }).lines.reduce((a, l) => a + l.count, 0);

  assert.equal(all.total, 4);
  assert.deepEqual(unl.packs.map((p) => p.name).sort(), ["company-pack", "nocat-pack"]);
  assert.equal(
    unl.total,
    all.total - sumLines,
    "the chip's count and the filter's result must be the same set",
  );
});

test("unlined never overlaps a line chip", async () => {
  const { createPackRegistry } = await import("../gateway/packs.js");
  const reg = createPackRegistry({ file: join(dir, "q.db") });
  reg.publish({ email: "a@x", manifest: mk("lex-pack", { category: "legal" }) });
  reg.publish({ email: "a@x", manifest: mk("orphan", { category: "consulting" }) });

  const facets = reg.facets({ locale: "zh" });
  const lineWords = facets.lines.map((l) => l.word);
  for (const word of lineWords) {
    const seen = reg.list({ viewer: { email: "" }, category: word }).packs.map((p) => p.id);
    const unl = reg.list({ viewer: { email: "" }, unlined: true }).packs.map((p) => p.id);
    for (const id of seen) assert.ok(!unl.includes(id), `${word} and unlined must not both list ${id}`);
  }
});

test("unlined is a boolean in the HTTP route, not a value", async () => {
  // A crafted `?unlined=<anything>` must not be read as a category string.
  // The route coerces only "1"/"true"; this pins the shape so a later edit
  // cannot quietly turn the flag into a passthrough filter value.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../gateway/packs.js", import.meta.url), "utf8");
  assert.match(
    src,
    /unlined:\s*unlined === "1" \|\| unlined === "true"/,
    "the route must coerce the flag, never forward it as a string",
  );
});
