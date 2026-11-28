#!/usr/bin/env node
// voice-catalog (openspec: add-room-voice-and-catalog, tasks 1.1/1.2).
//
// Pins the catalog's structural promises, in the order they matter:
//   1. the shipped file parses and groups by protocol;
//   2. a bad entry FAILS the read and names itself (never a silently empty catalog);
//   3. the overlay replaces the shipped file and is re-read on change;
//   4. three-layer resolution: seat > post > deployment, with a stale layer
//      SKIPPED and reported rather than falling silently to the default.
//
//   node --test scripts/test-voice-catalog.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIB = path.resolve(import.meta.dirname, "../server/voice-catalog.js");
const SHIPPED = path.resolve(import.meta.dirname, "../server/voice-catalog.json");

const { createVoiceCatalog, resolveVoice, validateCatalog, PROTOCOLS } = await import(LIB);

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "voice-catalog-"));

test("shipped catalog parses and carries both protocols", () => {
  const cat = createVoiceCatalog({ dir: path.join(tmpdir(), "none") });
  const { entries, default: fallback } = cat.get();
  assert.ok(entries.length >= 3, "shipped catalog has at least the two tencent rows + one doubao row");
  const protocols = new Set(entries.map((e) => e.protocol));
  for (const p of ["tencent", "doubao"]) assert.ok(protocols.has(p), `shipped catalog carries a ${p} entry`);
  for (const e of entries) {
    assert.ok(e.model && e.voice && e.label, "every entry is a complete triple with a label");
  }
  assert.equal(fallback.protocol, "tencent", "the default is the tencent entry (documented measurement, not the unverified doubao one)");
  assert.equal(fallback.voice, "101001");
});

test("every shipped entry has a protocol in the closed set", () => {
  const raw = JSON.parse(fs.readFileSync(SHIPPED, "utf8"));
  for (const e of raw.entries) assert.ok(PROTOCOLS.includes(e.protocol), `${e.voice} protocol is closed`);
});

test("a bad entry fails the read and names itself", () => {
  const missingVoice = validateCatalog({
    entries: [{ protocol: "tencent", model: "tencent-tts", voice: "101001" }, { protocol: "tencent", model: "tencent-tts" }],
  });
  assert.equal(missingVoice.ok, false);
  assert.match(missingVoice.error, /model is required|voice is required|entries\[1\]/);

  const badProtocol = validateCatalog({ entries: [{ protocol: "openai", model: "tts", voice: "alloy" }] });
  assert.equal(badProtocol.ok, false);
  assert.match(badProtocol.error, /protocol must be one of/);

  const dup = validateCatalog({
    entries: [
      { protocol: "tencent", model: "tencent-tts", voice: "101001" },
      { protocol: "tencent", model: "tencent-tts", voice: "101001" },
    ],
  });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /duplicate/);
});

test("default must name an existing entry", () => {
  const r = validateCatalog({
    entries: [{ protocol: "tencent", model: "tencent-tts", voice: "101001" }],
    default: { protocol: "tencent", model: "tencent-tts", voice: "999999" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /default must name one of the catalog entries/);
});

test("overlay replaces the shipped file and is re-read on change", () => {
  const dir = tmpdir();
  const file = path.join(dir, "voice-catalog.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: [{ protocol: "doubao", model: "doubao-speech", voice: "zh_male_x_uranus_bigtts", label: "覆盖音色" }] }),
  );
  const cat = createVoiceCatalog({ dir });
  let got = cat.get();
  assert.equal(got.entries.length, 1, "overlay wins over shipped defaults");
  assert.equal(got.entries[0].voice, "zh_male_x_uranus_bigtts");
  assert.equal(cat.source(), "overlay");

  // Change the file: the next read must see it (stat-on-read, not a build).
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: [{ protocol: "doubao", model: "doubao-speech", voice: "zh_female_y_uranus_bigtts", label: "改过" }] }),
  );
  got = cat.get();
  assert.equal(got.entries[0].voice, "zh_female_y_uranus_bigtts", "a changed overlay is re-read");
});

test("a broken overlay warns but the shipped defaults keep the surface alive", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "voice-catalog.json"), "{ not json");
  const warns = [];
  const cat = createVoiceCatalog({ dir, onWarn: (m) => warns.push(m) });
  const got = cat.get();
  assert.ok(got.entries.length >= 3, "defaults still load");
  assert.ok(warns.some((w) => /invalid/.test(w)), "the broken overlay is reported, not swallowed");
  assert.equal(cat.source(), "default");
});

test("entryFor is exact on the pair — a model from one protocol with another's voice is not allowed", () => {
  const cat = createVoiceCatalog({ dir: path.join(tmpdir(), "none") });
  assert.ok(cat.entryFor({ model: "tencent-tts", voice: "101001" }), "the exact pair is found");
  assert.equal(cat.entryFor({ model: "doubao-speech", voice: "101001" }), null, "voice without its own model is rejected");
  assert.equal(cat.entryFor({ model: "tencent-tts", voice: "" }), null);
  assert.equal(cat.isAllowed({ model: "tencent-tts", voice: "101007" }), false, "a de-listed voice is not allowed");
});

test("three-layer resolution: most specific wins", () => {
  const cat = createVoiceCatalog({ dir: path.join(tmpdir(), "none") });
  const seat = { model: "tencent-tts", voice: "101013" };
  const post = { model: "tencent-tts", voice: "101001" };

  let r = resolveVoice({ seat, post }, { catalog: cat });
  assert.equal(r.source, "seat");
  assert.equal(r.entry.voice, "101013");

  r = resolveVoice({ post }, { catalog: cat });
  assert.equal(r.source, "post");
  assert.equal(r.entry.voice, "101001");
});

test("three-layer resolution: nothing declared falls to the catalog default", () => {
  const cat = createVoiceCatalog({ dir: path.join(tmpdir(), "none") });
  const r = resolveVoice({}, { catalog: cat });
  assert.equal(r.source, "catalog-default");
  assert.equal(r.entry.voice, "101001");
});

test("a stale layer is SKIPPED and reported, never fatal", () => {
  const cat = createVoiceCatalog({ dir: path.join(tmpdir(), "none") });
  const stale = { model: "tencent-tts", voice: "101007" }; // documented as de-listed
  const good = { model: "tencent-tts", voice: "101001" };
  const r = resolveVoice({ seat: stale, post: good }, { catalog: cat });
  assert.equal(r.source, "post", "the stale seat layer is skipped and the post layer wins");
  assert.equal(r.entry.voice, "101001");
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].layer, "seat");
  assert.match(r.skipped[0].reason, /not in catalog/);
});
