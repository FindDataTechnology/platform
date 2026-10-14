// Unit checks for the app-center single source (openspec: add-app-center 1.1).
// Shape assertions only — rendering is covered by the e2e sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_LINES } from "../web/src/lib/appCatalog.ts";

const FIVE_LINES = ["yizuo", "facet", "wanxing", "lex", "wire"];

test("all five product lines present, stable ids", () => {
  assert.deepEqual(
    APP_LINES.map((l) => l.id).sort(),
    [...FIVE_LINES].sort(),
  );
});

test("exactly one line is the platform itself", () => {
  const self = APP_LINES.filter((l) => l.self);
  assert.equal(self.length, 1);
  assert.equal(self[0].id, "yizuo");
  assert.equal(self[0].url, null);
});

test("every non-self line points at its own domain over https", () => {
  for (const line of APP_LINES.filter((l) => !l.self)) {
    assert.ok(line.url, `${line.id}: url required`);
    assert.match(line.url, /^https:\/\/[a-z]+\.finddatatech\.cloud$/, `${line.id}: own domain`);
  }
});

test("status uses the honest enum", () => {
  for (const line of APP_LINES) {
    assert.ok(["live", "early"].includes(line.status), `${line.id}: bad status ${line.status}`);
  }
});

test("i18n keys exist in all five locales", () => {
  const locales = ["en", "es", "fr", "ja", "zh-CN"];
  for (const lang of locales) {
    const dict = JSON.parse(
      readFileSync(new URL(`../web/src/locales/${lang}/common.json`, import.meta.url)),
    );
    for (const line of APP_LINES) {
      for (const key of [line.nameKey, line.taglineKey]) {
        const [section, ...rest] = key.split(".");
        let node = dict;
        for (const part of [section, ...rest]) node = node?.[part];
        assert.ok(typeof node === "string" && node.length > 0, `${lang}: ${key} missing/empty`);
      }
    }
    assert.ok(dict.nav?.apps, `${lang}: nav.apps missing`);
    assert.ok(dict.appCenter?.title, `${lang}: appCenter.title missing`);
  }
});
