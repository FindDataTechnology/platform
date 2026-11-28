// Unit tests for the SPA static-headers leaf (openspec:
// harden-spa-shell-resilience, task 1.1). Framework-free, runs under plain
// node via `npm run test:unit`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySpaHeaders,
  HASHED_ASSET_CACHE_CONTROL,
  isHashedAsset,
  SHELL_CACHE_CONTROL,
  spaCacheControlFor,
} from "../lib/spa-static-headers.js";

test("content-hashed JS/CSS under assets/ is immutable", () => {
  assert.equal(isHashedAsset("/repo/web/dist/assets/index-D4tG9xQz.js"), true);
  assert.equal(isHashedAsset("/repo/web/dist/assets/ZhiyuPage-Bq_8wLm2.css"), true);
  assert.equal(spaCacheControlFor("/repo/web/dist/assets/index-D4tG9xQz.js"), HASHED_ASSET_CACHE_CONTROL);
});

test("the shell and non-hashed files are no-cache", () => {
  assert.equal(isHashedAsset("/repo/web/dist/index.html"), false);
  // an assets/ file WITHOUT the hash shape still revalidates
  assert.equal(isHashedAsset("/repo/web/dist/assets/logo.png"), false);
  assert.equal(spaCacheControlFor("/repo/web/dist/index.html"), SHELL_CACHE_CONTROL);
});

test("applySpaHeaders sets the right header per file", () => {
  const set = {};
  const res = { setHeader: (k, v) => (set[k] = v) };
  applySpaHeaders(res, "/d/assets/index-D4tG9xQz.js");
  assert.equal(set["Cache-Control"], HASHED_ASSET_CACHE_CONTROL);
  applySpaHeaders(res, "/d/index.html");
  assert.equal(set["Cache-Control"], SHELL_CACHE_CONTROL);
});
