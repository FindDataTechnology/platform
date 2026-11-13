#!/usr/bin/env node
// ── Facet shell labels: naming contract guard (overhaul-facet-shell-ia-and-space) ──
//
// The shell names each module by the task a viewer performs there, in the
// viewer's own language (facet-platform spec: "Navigation names modules by the
// viewer's task"). Before this suite, "Studio" survived untranslated in all
// five locales and 策展 read as museum curation — both lived only in locale
// JSON, so nothing caught a regression. This pins the contract:
//
//   1. every locale carries the same entry/account keys;
//   2. no translated locale is left holding the English source string;
//   3. zh-CN carries no Latin word outside the MCP whitelist;
//   4. the zh-CN label set is exactly the decided one;
//   5. docs copy refers to the author surface by the label the entry uses
//      (one concept, one name), and never by an internal architecture term.
//
//   node --test scripts/test-facet-shell-labels.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "zh-CN", "es", "fr", "ja"];
const SOURCE = "en";

/** Acronyms that stay in Latin script by decision, not by omission. */
const LATIN_WHITELIST = ["MCP"];

/** Labels whose correct translation IS the English word (cognate, not a
 *  missed translation). Recorded per `locale.group.key` — adding one here is a
 *  claim that the target language really uses the same word, so the guard stays
 *  strict for everything else. */
const COGNATES = new Set(["fr.entries.docs"]); // « Guide » est le mot français

/** The decided label set (proposal: naming by task, one concept one name). */
const ZH_ENTRIES = {
  intro: "介绍",
  packs: "智能体市场",
  mcp: "MCP 与技能",
  docs: "使用指南",
  studio: "创作台",
};
const ZH_ACCOUNT = { menuLabel: "账号", mine: "我的发布", curate: "内容运营" };

const load = (locale) =>
  JSON.parse(readFileSync(path.join(root, "web", "src", "locales", locale, "common.json"), "utf8"));

const shellOf = (locale) => load(locale).facetShell;

test("every locale carries the same entry and account keys", () => {
  const source = shellOf(SOURCE);
  for (const locale of LOCALES) {
    const shell = shellOf(locale);
    assert.deepEqual(Object.keys(shell.entries).sort(), Object.keys(source.entries).sort(), `${locale} entries`);
    assert.deepEqual(Object.keys(shell.account).sort(), Object.keys(source.account).sort(), `${locale} account`);
    // The retired namespace must not linger: a leftover `tabs` block means a
    // half-done rename that silently renders raw keys at runtime.
    assert.equal(shell.tabs, undefined, `${locale} still carries facetShell.tabs`);
  }
});

test("no translated locale is left holding the English source string", () => {
  const source = shellOf(SOURCE);
  for (const locale of LOCALES.filter((l) => l !== SOURCE)) {
    for (const group of ["entries", "account"]) {
      for (const [key, value] of Object.entries(source[group])) {
        if (COGNATES.has(`${locale}.${group}.${key}`)) continue;
        assert.notEqual(
          shellOf(locale)[group][key],
          value,
          `${locale}.${group}.${key} still reads the English source (${JSON.stringify(value)})`,
        );
      }
    }
  }
});

test("zh-CN carries no Latin word outside the MCP whitelist", () => {
  const shell = shellOf("zh-CN");
  for (const group of ["entries", "account"]) {
    for (const [key, value] of Object.entries(shell[group])) {
      let stripped = value;
      for (const ok of LATIN_WHITELIST) stripped = stripped.replaceAll(ok, "");
      assert.equal(
        /[A-Za-z]/.test(stripped),
        false,
        `zh-CN.${group}.${key} = ${JSON.stringify(value)} carries untranslated Latin text`,
      );
    }
  }
});

test("zh-CN labels are exactly the decided set", () => {
  assert.deepEqual(shellOf("zh-CN").entries, ZH_ENTRIES);
  assert.deepEqual(shellOf("zh-CN").account, ZH_ACCOUNT);
});

test("the view titles agree with their entries", () => {
  // The creation face's own title bar is gone (single chrome row); the docs
  // view's title names the same module as the entries row.
  const zh = load("zh-CN");
  assert.equal(zh.facetDocs.title, ZH_ENTRIES.docs, "facetDocs.title must match entries.docs");
  assert.equal(zh.facetCurate.title, ZH_ACCOUNT.curate, "facetCurate.title must match account.curate");
  // 我的发布 had TWO names: the account entry (and every doc reference) said
  // 我的发布 while its own page heading said 我的智能体 — the exact
  // one-concept-two-names drift this change exists to remove. Pinned in every
  // locale, not just zh: the other four had the same split.
  for (const locale of LOCALES) {
    const doc = load(locale);
    assert.equal(
      doc.facetMine.title,
      doc.facetShell.account.mine,
      `${locale}: facetMine.title must match facetShell.account.mine`,
    );
  }
});

test("docs name the author surface with the entry's label", () => {
  for (const locale of LOCALES) {
    const doc = load(locale);
    const label = doc.facetShell.account.mine;
    assert.equal(
      doc.facetDocs.create.route3.includes(label),
      true,
      `${locale}: facetDocs.create.route3 must name the author surface ${JSON.stringify(label)}`,
    );
  }
});

test("docs carry no internal architecture term for the author surface", () => {
  // "作者面" / "creator console" read as platform structure, not as a place the
  // author recognizes; the entry label replaced them.
  const banned = ["作者面", "author surface", "creator console", "consola del autor", "console d'auteur", "作者コンソール"];
  for (const locale of LOCALES) {
    const doc = load(locale);
    const haystack = JSON.stringify(doc.facetDocs);
    for (const term of banned) {
      assert.equal(haystack.includes(term), false, `${locale}: facetDocs still says ${JSON.stringify(term)}`);
    }
  }
});

test("no facet-owned surface uses the retired term 功能集", () => {
  // 「功能集」 was retired on 2026-10-27 (docs/creating-packs.md §1.5: the
  // distributable unit is 能力包, the market is 能力市场). It survived in the
  // shell's own browser-tab title and in every CLI message — surfaces no
  // locale-key guard looks at, because they are not in common.json. 壹座's
  // remaining uses (agents.market.*) are that product's copy, not ours.
  const retired = "功能集";
  const surfaces = [
    "facet/web/index.html",
    "facet/cli/facet.js",
    "facet/cli/README.md",
  ];
  for (const rel of surfaces) {
    const text = readFileSync(path.join(root, rel), "utf8");
    assert.equal(text.includes(retired), false, `${rel} still says ${JSON.stringify(retired)} — the retired term`);
  }
  // And the browser tab must name the market the way the entry row does.
  const html = readFileSync(path.join(root, "facet", "web", "index.html"), "utf8");
  assert.equal(html.includes("智能体市场"), true, "index.html <title> must use the same market label as the entry row");
  assert.equal(html.includes("智能体市场") && html.includes("<title>"), true);
});

test("no facet-owned surface carries a truncated copy of the retired term", () => {
  // 功能集 was retired, but the corpus ALSO held 「功集」 — the same term with
  // 能 lost, in the CLI's own help text and in a doc command sample. A reader
  // copies `facet publish <功集id>` and it cannot work. The 功能集 check above
  // cannot see it (different string), so pin the fragment too.
  const fragment = "功集";
  for (const rel of ["facet/web/index.html", "facet/cli/facet.js", "facet/cli/README.md", "docs/creating-packs.md"]) {
    const text = readFileSync(path.join(root, rel), "utf8");
    assert.equal(text.includes(fragment), false, `${rel} still says ${JSON.stringify(fragment)} — truncated 功能集`);
  }
});

test("the unit is called 智能体 everywhere a reader can see it", () => {
  // 2026-11-11 ruling: user-facing copy says 智能体 (en: Agent), market =
  // 智能体市场. 能力包 was the glossary's word for ~2 weeks and never appeared in
  // the product; leaving it in the CLI while the shell/壹座/docs said 智能体 made
  // one concept carry two names. The glossary line itself may name the retired
  // term — that is the one place allowed to, and it says 停用 on the same line.
  const retired = "能力包";
  const surfaces = ["facet/web/index.html", "facet/cli/facet.js", "facet/cli/README.md", "docs/creating-packs.md"];
  for (const rel of surfaces) {
    const lines = readFileSync(path.join(root, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(retired)) return;
      assert.equal(
        line.includes("停用"),
        true,
        `${rel}:${i + 1} still says ${JSON.stringify(retired)} outside the retirement note: ${line.trim().slice(0, 80)}`,
      );
    });
  }
});
