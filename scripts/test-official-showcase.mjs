#!/usr/bin/env node
// ── Official showcase tests (add-official-pack-showcase) ─────────────────────
//
// Pins the three contract faces on the gateway packs mount:
//   1. the anonymous READ switch (PACK_ANONYMOUS_READ): public browsable/
//      detail-able anonymously when on; the wall holds when off; writes 401
//      in both postures; private/unlisted invisible either way
//   2. the official badge: derived ONLY from the deployment roster (never
//      author-declared), re-derived on roster change without any write,
//      presentation-level (visibility/curation untouched)
//   3. GET /api/packs/official: three segments (blueprint templates /
//      facade+assistant conversational / featured), anonymous-readable
//      regardless of the switch, private packs in NO segment, empty roster →
//      honest empty segments (200, not an error)
//
//   node --test scripts/test-official-showcase.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "official-showcase-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const FLEET_MANIFEST = () => ({
  name: "客服班组模板",
  description: "官方团队模板：三岗客服班组",
  visibility: "public",
  tags: ["模板"],
  agents: [{ id: "lead", name: "组长", persona: "p" }],
  fleet: { name: "客服班组", members: [{ ref: "lead", title: "组长", target: { kind: "existing-persona", id: "p" } }] },
});

const ASSISTANT_MANIFEST = () => ({
  name: "谦面助手",
  description: "官方助手：市场向导",
  visibility: "public",
  tags: ["助手"],
  agents: [{ id: "guide", name: "向导", persona: "p", serving: { protocol: "a2a", card: { name: "向导", description: "d", examples: ["q"] } } }],
});

const PLAIN_MANIFEST = () => ({
  name: "普通包",
  description: "名单外作者的工具包",
  visibility: "public",
  tags: [],
  skills: [{ name: "s", description: "d", content: "# s" }],
});

function seedRegistry() {
  const reg = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmp, "reg-")), "packs.db") });
  // Official roster author: one team template, one assistant, one admin-curated
  // featured (featured is a curation column, never a manifest key).
  const template = reg.publish({ email: "official@finddata.cloud", manifest: FLEET_MANIFEST() });
  const assistant = reg.publish({ email: "official@finddata.cloud", manifest: ASSISTANT_MANIFEST() });
  const featured = reg.publish({ email: "official@finddata.cloud", manifest: { ...PLAIN_MANIFEST(), name: "官方精选" } });
  reg.setCuration({ id: featured.id, actor: { email: "admin@x", admin: true }, featured: true });
  // Outsider author: a team-shaped pack that must NOT enter the official
  // segments even though its structure matches (self-declaration is ignored).
  const outsider = reg.publish({ email: "random@x", manifest: { ...FLEET_MANIFEST(), name: "路人模板" } });
  // Private official pack: invisible in every segment.
  const priv = reg.publish({ email: "official@finddata.cloud", manifest: { ...ASSISTANT_MANIFEST(), name: "私有助手", visibility: "private" } });
  return { reg, template, assistant, featured, outsider, priv };
}

function mountApp(reg, { anonymousRead = false, officialAuthors = [] } = {}) {
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    resolveUser: () => null, // every caller anonymous
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
    anonymousRead,
    officialAuthors,
  });
  const server = http.createServer(app);
  server.listen(0);
  return server;
}

const get = (server, p) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (server, p, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status }));

test("official badge derives from the roster, never from author declarations", async () => {
  const { reg, template, outsider } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: true, officialAuthors: ["Official@FindData.cloud"] });
  try {
    const list = await get(server, "/api/packs");
    const byId = Object.fromEntries(list.body.packs.map((p) => [p.id, p]));
    assert.equal(byId[template.id].official, true, "roster member (case-insensitive) is official");
    assert.equal(byId[outsider.id].official ?? false, false, "a team-shaped pack by an outsider is NOT official");
  } finally {
    server.close();
    reg.close();
  }
});

test("roster change re-derives the flag on the next read, without any write", async () => {
  const { reg, template } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: true, officialAuthors: ["official@finddata.cloud"] });
  try {
    assert.equal((await get(server, "/api/packs")).body.packs.find((p) => p.id === template.id).official, true);
  } finally {
    server.close();
  }
  // Same registry, new mount with the author removed — no packs.db write.
  const server2 = mountApp(reg, { anonymousRead: true, officialAuthors: [] });
  try {
    const list = await get(server2, "/api/packs");
    assert.equal(list.body.packs.find((p) => p.id === template.id).official, false);
  } finally {
    server2.close();
    reg.close();
  }
});

// ── P2 3.6 官方徽章收敛 (overhaul-market-catalog-presentation) ───────────────
// The badge on EVERY read face is the roster's answer — never the manifest's
// self-declaration, never a client inference. Two faces have historically been
// where a projection drops a flag (repo law: 写面修过、读面漏网): the localized
// list track and the detail route.

test("徽章收敛①：本地化轨道不丢 official（en 轨与 zh 轨同一裁决）", async () => {
  const { reg, template, outsider } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: true, officialAuthors: ["official@finddata.cloud"] });
  try {
    for (const url of ["/api/packs?locale=en", "/api/packs"]) {
      const list = await get(server, url);
      const byId = Object.fromEntries(list.body.packs.map((p) => [p.id, p]));
      assert.equal(byId[template.id].official, true, `${url}: 名册作者在本地化轨道上仍是官方`);
      assert.ok(byId[template.id].name, `${url}: summary 完好`);
      assert.equal(byId[outsider.id].official ?? false, false, `${url}: 名册外条目任何轨道都不带官方`);
    }
  } finally {
    server.close();
    reg.close();
  }
});

test("徽章收敛②：详情面同样只按名册；adopted 记录不给名册外作者发官方", async () => {
  const { reg, template, outsider } = seedRegistry();
  // A NON-roster author who self-declares official-adopted provenance: the
  // source projection must read community (describeProvenance gate), and the
  // pack must not gain the official flag on the detail face either.
  const faked = reg.publish({
    email: "random@x",
    manifest: { ...PLAIN_MANIFEST(), name: "冒牌已审校", provenance: { kind: "official-adopted", upstream: "x" } },
  });
  const server = mountApp(reg, { anonymousRead: true, officialAuthors: ["official@finddata.cloud"] });
  try {
    const det = await get(server, `/api/packs/${template.id}`);
    assert.equal(det.body.official, true, "详情面官方=名册判定");
    const detOut = await get(server, `/api/packs/${outsider.id}`);
    assert.equal(detOut.body.official ?? false, false, "详情面对名册外不发官方");
    const detFake = await get(server, `/api/packs/${faked.id}`);
    assert.equal(detFake.body.official ?? false, false, "自报 provenance 换不来官方");
    // community carries NO provenance key at all — the documented contract:
    // a non-roster pack's payload stays byte-identical to a legacy pack's.
    assert.equal(detFake.body.provenance, undefined, `adopted 记录×名册外 = community(无键)，实际: ${JSON.stringify(detFake.body.provenance)}`);
  } finally {
    server.close();
    reg.close();
  }
});

test("showcase: three segments, roster-only, private in none, anonymous regardless of the switch", async () => {
  const { reg, template, assistant, featured, outsider, priv } = seedRegistry();
  // The switch is OFF — /api/packs walls, but /api/packs/official still answers.
  const server = mountApp(reg, { anonymousRead: false, officialAuthors: ["official@finddata.cloud"] });
  try {
    const wall = await get(server, "/api/packs");
    assert.equal(wall.status, 401, "anonymousRead off keeps the login wall on the listing");

    const show = await get(server, "/api/packs/official");
    assert.equal(show.status, 200);
    if (process.env.SHOWCASE_DEBUG) console.log("SHOWCASE:", JSON.stringify(show.body).slice(0, 900));
    assert.deepEqual(show.body.templates.map((p) => p.id), [template.id], "roster-only templates");
    assert.deepEqual(show.body.assistants.map((p) => p.id), [assistant.id], "roster-only assistants; private absent");
    assert.deepEqual(show.body.featured.map((p) => p.id), [featured.id], "featured segment present");
    const ids = new Set([...show.body.templates, ...show.body.assistants, ...show.body.featured].map((p) => p.id));
    assert.equal(ids.has(priv.id), false, "private pack in no segment");
    assert.equal(ids.has(outsider.id), false, "outsider pack in no segment");
    assert.ok(show.body.templates[0].name, "segments carry public display fields");
    assert.equal(JSON.stringify(show.body).includes("私有助手"), false, "no private content leaks");
  } finally {
    server.close();
    reg.close();
  }
});

test("showcase with an empty roster: official segments empty; curated featured stays (D5)", async () => {
  const { reg, featured } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: false, officialAuthors: [] });
  try {
    const show = await get(server, "/api/packs/official");
    assert.equal(show.status, 200);
    assert.deepEqual(show.body.templates, [], "no roster → no official templates");
    assert.deepEqual(show.body.assistants, [], "no roster → no official assistants");
    // The admin-curated pack stays in the featured segment — operations
    // curation is a different concept from official provenance (D5), and it
    // must carry official:false so the UI cannot badge it as 官方.
    assert.deepEqual(show.body.featured.map((p) => p.id), [featured.id]);
    assert.equal(show.body.featured[0].official, false);
  } finally {
    server.close();
    reg.close();
  }
});

test("anonymous read switch: on = public browsable + writes 401; off = wall", async () => {
  const { reg } = seedRegistry();
  const on = mountApp(reg, { anonymousRead: true, officialAuthors: ["official@finddata.cloud"] });
  try {
    const list = await get(on, "/api/packs");
    assert.equal(list.status, 200);
    assert.equal(list.body.packs.length, 4, "public rows only (private invisible)");
    assert.equal((await get(on, "/api/packs")).body.packs.every((p) => p.visibility !== "private"), true);
    assert.equal((await post(on, "/api/packs", { manifest: ASSISTANT_MANIFEST() })).status, 401, "writes keep the wall");
  } finally {
    on.close();
  }
  const off = mountApp(reg, { anonymousRead: false, officialAuthors: [] });
  try {
    assert.equal((await get(off, "/api/packs")).status, 401, "default mount keeps the login wall");
    assert.equal((await get(off, "/api/packs/official")).status, 200, "showcase still anonymous (public fields only)");
  } finally {
    off.close();
    reg.close();
  }
});
