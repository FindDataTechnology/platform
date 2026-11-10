// Unit checks for the app-center single source (openspec: add-app-center 1.1,
// app-center-unified-grid 2.x). Shape assertions only — rendering is covered
// by the e2e sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APP_LINES,
  APP_CONNECTIONS,
  BOARD_CREDENTIAL,
  boardAvailable,
  boardPathFor,
  brandOf,
  buildAppGrid,
  aggregateConnectionState,
  connectTargetFor,
  hasBoard,
} from "../web/src/lib/appCatalog.ts";

const FIVE_LINES = ["yizuo", "facet", "wanxing", "lex", "wire"];
const LOCALES = ["en", "es", "fr", "ja", "zh-CN"];
// Same id list e2e/connections.spec.js asserts against the live endpoint.
const KNOWN_CONNECTION_IDS = [
  "registry",
  "facet-market",
  "connector",
  "line-wire-customer",
  "line-lex",
  "ciyuan-account",
  "paper-trading",
  "search",
];

const CATALOG_APPS = JSON.parse(readFileSync(new URL("../agents.json", import.meta.url), "utf8")).apps.filter((a) =>
  ["external-service", "link", "nango-connect"].includes(a.kind),
);

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
  for (const lang of LOCALES) {
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

// ── app-center-unified-grid ────────────────────────────────────────────────

test("unified grid: bundled products are attributed and brand-ordered (2.1)", () => {
  const order = buildAppGrid(APP_LINES, CATALOG_APPS).map((e) => e.id);
  // add-crm-desk-pack-embed: the desk embed card joins the yizuo brand group.
  // agent-fleet-templates: the fleet-templates card joins it too.
  assert.deepEqual(order, [
    "yizuo",
    "yizuo-packs",
    "crm-desk",
    "fleet-templates",
    "facet",
    "wanxing",
    "wanxing-token",
    "wanxing-connector",
    "lex",
    "wire",
  ]);
});

test("unified grid: empty or failed catalog keeps the five brand cards (2.1)", () => {
  assert.deepEqual(
    buildAppGrid(APP_LINES, null).map((e) => e.id),
    FIVE_LINES,
  );
  assert.deepEqual(
    buildAppGrid(APP_LINES, []).map((e) => e.id),
    FIVE_LINES,
  );
});

test("brandOf: explicit line field wins over prefix; unknown prefix sorts last (2.1)", () => {
  assert.equal(brandOf({ id: "yizuo-packs", kind: "link" }), "yizuo");
  assert.equal(brandOf({ id: "wanxing-token", kind: "external-service" }), "wanxing");
  // Explicit attribution routes a non-prefix id to its brand.
  assert.equal(brandOf({ id: "mystery", kind: "link", line: "lex" }), "lex");
  // An explicit line naming an unknown brand falls through to inference.
  assert.equal(brandOf({ id: "wire-thing", kind: "link", line: "nope" }), "wire");
  assert.equal(brandOf({ id: "orphan-tool", kind: "link" }), null);

  const ids = buildAppGrid(APP_LINES, [
    { id: "mystery", kind: "link", name: "M", url: "https://example.com", line: "lex" },
    { id: "orphan-tool", kind: "link", name: "O", url: "https://example.com" },
  ]).map((e) => e.id);
  assert.deepEqual(ids, ["yizuo", "facet", "wanxing", "lex", "mystery", "wire", "orphan-tool"]);
});

test("unified grid: product flags carry through (embedded branch, name fallback) (2.1)", () => {
  const [embed, disabled] = buildAppGrid(APP_LINES, [
    { id: "wanxing-embed", kind: "external-service", name: "E" },
    { id: "wanxing-off", kind: "external-service", name: "F", embedded: false },
  ]).filter((e) => e.kind === "product");
  assert.equal(embed.embedded, true);
  assert.equal(disabled.embedded, false);
  const [named] = buildAppGrid(APP_LINES, [{ id: "facet-thing", kind: "link" }]).filter(
    (e) => e.kind === "product",
  );
  assert.equal(named.name, "facet-thing"); // catalog name missing → id
});

test("aggregateConnectionState: four states, stale beats partial, missing id counts as disconnected (2.2)", () => {
  assert.equal(aggregateConnectionState([], {}), null);
  assert.equal(aggregateConnectionState(["a"], { a: "connected" }), "connected");
  assert.equal(
    aggregateConnectionState(["a", "b"], { a: "connected", b: "disconnected" }),
    "partial",
  );
  assert.equal(aggregateConnectionState(["a", "b"], { a: "stale", b: "connected" }), "stale");
  assert.equal(aggregateConnectionState(["a", "b"], { a: "stale", b: "disconnected" }), "stale");
  assert.equal(aggregateConnectionState(["a"], {}), "disconnected");
  assert.equal(aggregateConnectionState(["a"], { a: "not-configured" }), "disconnected");
});

test("connectTargetFor: first non-connected in declaration order; null when all green (2.2)", () => {
  const wire = APP_CONNECTIONS.wire; // [line-wire-customer, paper-trading]
  assert.equal(
    connectTargetFor(wire, { "line-wire-customer": "connected", "paper-trading": "disconnected" }),
    "paper-trading",
  );
  assert.equal(
    connectTargetFor(wire, { "line-wire-customer": "connected", "paper-trading": "connected" }),
    null,
  );
  assert.equal(connectTargetFor(wire, {}), "line-wire-customer");
});

test("APP_CONNECTIONS maps only known ids; search never mapped; 壹座/萬星 cards badge-free (2.3)", () => {
  for (const ids of Object.values(APP_CONNECTIONS)) {
    for (const id of ids) assert.ok(KNOWN_CONNECTION_IDS.includes(id), `unknown connection id ${id}`);
  }
  assert.equal(
    Object.values(APP_CONNECTIONS)
      .flat()
      .includes("search"),
    false,
  );
  assert.equal(APP_CONNECTIONS.yizuo, undefined);
  assert.equal(APP_CONNECTIONS.wanxing, undefined);
  assert.deepEqual(Object.keys(APP_CONNECTIONS).sort(), [
    "facet",
    "lex",
    "wanxing-connector",
    "wanxing-token",
    "wire",
    "yizuo-packs",
  ]);
});

test("unified-grid copy exists in all five locales; retired headings gone (2.4)", () => {
  for (const lang of LOCALES) {
    const dict = JSON.parse(
      readFileSync(new URL(`../web/src/locales/${lang}/common.json`, import.meta.url)),
    );
    for (const key of ["connected", "partial", "stale", "disconnected", "connect"]) {
      const v = dict.appCenter?.connection?.[key];
      assert.ok(typeof v === "string" && v.length > 0, `${lang}: appCenter.connection.${key} missing/empty`);
    }
    assert.ok(
      typeof dict.appCenter?.subtitle === "string" && dict.appCenter.subtitle.length > 0,
      `${lang}: appCenter.subtitle missing/empty`,
    );
    assert.equal(dict.appCenter?.linesHeading, undefined, `${lang}: appCenter.linesHeading must be gone`);
    assert.equal(dict.appCenter?.appsHeading, undefined, `${lang}: appCenter.appsHeading must be gone`);
  }
});

// ── add-wire-line-board (app-center MODIFIED: 柏讯加入看板线) ─────────────────

test("no board line carries an 'early' badge; lex joined wire as live (add-lex-line-board)", () => {
  const byId = Object.fromEntries(APP_LINES.map((l) => [l.id, l]));
  assert.equal(byId.wire.status, "live", "wire has a real board now — no early badge");
  // lex gained its own board (add-lex-line-board) after this test was written:
  // the same rule applies — the badge follows the board, not the roadmap.
  assert.equal(byId.lex.status, "live", "lex has a real board too — same rule as wire");
  assert.equal(byId.facet.status, "live");
  assert.equal(byId.wanxing.status, "live");
});

test("board lines and their own credential (D7): facet→facet-market, wire→line-wire-customer, lex→line-lex, wanxing→none", () => {
  assert.deepEqual(Object.keys(BOARD_CREDENTIAL).sort(), ["facet", "lex", "wanxing", "wire"]);
  assert.equal(BOARD_CREDENTIAL.facet, "facet-market");
  assert.equal(BOARD_CREDENTIAL.wire, "line-wire-customer");
  assert.equal(BOARD_CREDENTIAL.lex, "line-lex", "识律 adapter + spec shipped without a door — the card must offer 看板");
  assert.equal(BOARD_CREDENTIAL.wanxing, null);
  for (const id of ["facet", "lex", "wanxing", "wire"]) assert.ok(hasBoard(id), id);
  // base is the host: a board there would be the platform looking at itself.
  for (const id of ["base", "yizuo", "yizuo-packs", "wanxing-token"]) assert.equal(hasBoard(id), false, id);
  assert.equal(boardPathFor("wire"), "/boards/wire");
  assert.equal(boardPathFor("lex"), "/boards/lex");
});

test("boardAvailable: wire shows the board on its OWN credential even when the card aggregate is partial", () => {
  const partial = { "line-wire-customer": "connected", "paper-trading": "disconnected" };
  assert.equal(aggregateConnectionState(APP_CONNECTIONS.wire, partial), "partial", "precondition: card badge is partial");
  assert.equal(boardAvailable("wire", partial, true), true, "board still offered");
  assert.equal(boardAvailable("wire", { "line-wire-customer": "disconnected", "paper-trading": "connected" }, true), false);
  assert.equal(boardAvailable("wire", {}, true), false);
  assert.equal(boardAvailable("wire", null, true), false, "no /api/connections projection = not connected");
});

test("boardAvailable: facet needs facet-market; wanxing needs nothing; lex needs line-lex", () => {
  assert.equal(boardAvailable("facet", { "facet-market": "connected" }, true), true);
  assert.equal(boardAvailable("facet", { "facet-market": "stale" }, true), false);
  assert.equal(boardAvailable("wanxing", {}, true), true);
  assert.equal(boardAvailable("wanxing", null, true), true);
  // lex's own credential gates it, exactly like wire's — an unconnected 识律
  // card must not offer a board whose blocks would all be the connect card.
  assert.equal(boardAvailable("lex", { "line-lex": "connected" }, true), true);
  assert.equal(boardAvailable("lex", { "line-lex": "disconnected" }, true), false);
  assert.equal(boardAvailable("lex", null, true), false);
});

test("boardAvailable: the deployment switch off hides every board (D8 rollback)", () => {
  const allGreen = {
    "facet-market": "connected",
    "line-wire-customer": "connected",
    "paper-trading": "connected",
    "line-lex": "connected",
  };
  for (const id of ["facet", "wanxing", "wire", "lex"]) {
    assert.equal(boardAvailable(id, allGreen, false), false, `${id} must not offer a board when disabled`);
  }
});

test("appCenter.openOrigin + board copy exist in all five locales (7.2)", () => {
  for (const lang of LOCALES) {
    const dict = JSON.parse(readFileSync(new URL(`../web/src/locales/${lang}/common.json`, import.meta.url)));
    assert.ok(typeof dict.appCenter?.openOrigin === "string" && dict.appCenter.openOrigin.length > 0, `${lang}: appCenter.openOrigin`);
    for (const key of ["datasets", "artifacts", "demands"]) {
      assert.ok(typeof dict.board?.tab?.[key] === "string", `${lang}: board.tab.${key}`);
    }
    for (const key of ["title", "body", "expiredTitle", "expiredBody", "connect"]) {
      assert.ok(typeof dict.board?.unconnected?.[key] === "string", `${lang}: board.unconnected.${key}`);
    }
    for (const key of ["pending", "approved", "executed", "rejected", "expired"]) {
      assert.ok(typeof dict.action?.state?.[key] === "string", `${lang}: action.state.${key}`);
    }
    for (const key of ["source_urls", "public_data_asserted"]) {
      assert.ok(typeof dict.action?.field?.[key] === "string", `${lang}: action.field.${key}`);
    }
  }
});
