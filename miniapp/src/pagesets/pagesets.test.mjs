// Unit tests for the pageset host layer's pure decisions (openspec:
// add-erp-miniapp-pagesets 1.2 — 按租户授权组合装载且未授权不可见).
// Coverage per the task's acceptance line: 无授权 → 入口不渲染 → 直入路由被拦.
// Same pattern as markdown.test.mjs: node --test importing the .ts source.

import test from "node:test";
import assert from "node:assert/strict";
import {
  guardDecision,
  isPageReachable,
  isPagesetVisible,
  pageBlockReason,
  parsePagesetAuth,
  visiblePagesets,
} from "./authorize.ts";
import { PAGESETS, pageByPath, pagesetByPagePath, pagesetByKey } from "./registry.ts";
import { DEFAULT_TIMEOUT_MESSAGE } from "../components/ConfirmGate/confirm-gate.ts";

test("registry integrity: four pagesets, 12/10/8/8 pages, all paths unique and namespaced", () => {
  assert.equal(PAGESETS.length, 4);
  const byKey = Object.fromEntries(PAGESETS.map((p) => [p.key, p.pages.length]));
  assert.deepEqual(byKey, {
    "supply-chain.ue": 12,
    "supply-chain.se": 10,
    "supply-chain.sp": 8,
    "supply-chain.cp": 8,
  });

  const seen = new Set();
  for (const def of PAGESETS) {
    for (const page of def.pages) {
      assert.ok(!seen.has(page.path), `duplicate path ${page.path}`);
      seen.add(page.path);
      assert.match(page.path, new RegExp(`^pages\\/${def.key.split(".")[1]}\\/.+`), page.path);
      // D2 namespace: pages/<surface>/<page-id minus prefix>
      const expectedTail = page.id.replace(/^[a-z]+-/, "");
      assert.ok(page.path.endsWith(expectedTail), `${page.path} vs id ${page.id}`);
      // Every pageset carries a home page as its entry.
    }
    assert.ok(def.pages.some((p) => p.id === `${def.key.split(".")[1]}-home`), def.key);
    assert.ok(def.requiredGrants.length > 0);
  }
});

test("registry paths round-trip through the lookups", () => {
  assert.equal(pagesetByKey("supply-chain.ue")?.id, "supply-chain-ue-commerce");
  assert.equal(pageByPath("pages/cp/pickup-checkin")?.title, "提货打卡");
  assert.equal(pagesetByPagePath("pages/cp/pickup-checkin")?.key, "supply-chain.cp");
  // The base's own pages belong to no pageset.
  assert.equal(pagesetByPagePath("pages/chat/index"), undefined);
  assert.equal(pageByPath("pages/chat/index"), undefined);
});

test("parse fail-closed: malformed payloads yield an EMPTY grant set", () => {
  assert.deepEqual(parsePagesetAuth(null), {});
  assert.deepEqual(parsePagesetAuth("nope"), {});
  assert.deepEqual(parsePagesetAuth({}), {});
  assert.deepEqual(parsePagesetAuth({ pagesets: "all" }), {});
  assert.deepEqual(parsePagesetAuth({ pagesets: [{ key: "supply-chain.ue" }] }), {});
  assert.deepEqual(parsePagesetAuth({ pagesets: [{ key: "supply-chain.ue", grants: ["ok", 42] }] }), {});
  // Unknown key: reject the WHOLE payload (no partial trust).
  assert.deepEqual(parsePagesetAuth({ pagesets: [{ key: "supply-chain.xx", grants: [] }] }), {});
  // One bad row poisons the batch.
  assert.deepEqual(
    parsePagesetAuth({ pagesets: [{ key: "supply-chain.ue", grants: [] }, { key: 7, grants: [] }] }),
    {},
  );
});

test("parse accepts a well-formed payload", () => {
  const grants = parsePagesetAuth({
    pagesets: [
      { key: "supply-chain.ue", grants: ["catalog.read", "order.write"] },
      { key: "supply-chain.cp", grants: ["waybill.read", "waybill.accept", "dock.reserve", "pickup.checkin", "pod.report", "freight.statement.read", "ai.chat"] },
    ],
  });
  assert.deepEqual(grants["supply-chain.ue"], ["catalog.read", "order.write"]);
  assert.equal(grants["supply-chain.se"], undefined);
});

test("no authorization -> no entries render (入口不渲染)", () => {
  const ue = pagesetByKey("supply-chain.ue");
  assert.equal(isPagesetVisible(ue, {}), false);
  assert.deepEqual(visiblePagesets({}), []);
  // Unknown/loading status renders nothing as well.
  assert.deepEqual(visiblePagesets(undefined ?? {}), []);
});

test("entry visibility = pagesetKey authorization (D2), not the grant catalog", () => {
  const ue = pagesetByKey("supply-chain.ue");
  // Key listed -> entries appear; the server enforces grants per page.
  assert.equal(isPagesetVisible(ue, { "supply-chain.ue": [] }), true);
  assert.equal(isPagesetVisible(ue, { "supply-chain.ue": ["catalog.read"] }), true);
  // Key absent -> invisible (invisible ≠ grayed out).
  assert.equal(isPagesetVisible(ue, {}), false);
  assert.deepEqual(visiblePagesets({}), []);
  // Unknown/loading status renders nothing as well.
  assert.deepEqual(visiblePagesets(undefined ?? {}), []);
});

test("page-level grants gate individual pages inside an authorized pageset", () => {
  const ue = pagesetByKey("supply-chain.ue");
  // Pageset authorized, page-grant missing -> that page blocked, others open.
  const grants = { "supply-chain.ue": ["catalog.read", "ai.chat"] };
  assert.equal(isPageReachable(ue, "pages/ue/home", grants), true); // no page grants
  assert.equal(isPageReachable(ue, "pages/ue/order-create", grants), false); // needs order.write
  assert.equal(isPageReachable(ue, "pages/ue/statement-confirm", grants), false); // needs statement.confirm
  assert.equal(isPageReachable(ue, "pages/ue/ai-assistant", grants), true); // ai.chat granted
  // Granting order.write opens exactly that page.
  const withOrder = { "supply-chain.ue": [...grants["supply-chain.ue"], "order.write"] };
  assert.equal(isPageReachable(ue, "pages/ue/order-create", withOrder), true);
  // Pageset NOT authorized -> nothing reachable, even with grants present.
  assert.equal(isPageReachable(ue, "pages/ue/home", {}), false);
  // Unknown page path in a known pageset: not reachable.
  assert.equal(isPageReachable(ue, "pages/ue/nonexistent", grants), false);
});

test("visiblePagesets composes entries in registry order with only reachable pages", () => {
  const grants = parsePagesetAuth({
    pagesets: [
      { key: "supply-chain.sp", grants: ["po.read", "po.accept", "delivery.feedback", "statement.read", "invoice.upload", "ai.chat"] },
    ],
  });
  const entries = visiblePagesets(grants);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].def.key, "supply-chain.sp");
  assert.equal(entries[0].pages.length, 8);
  // UE/SE/CP authorized=no → completely absent (invisible ≠ grayed out).
  const none = visiblePagesets({});
  assert.deepEqual(none, []);
});

test("route guard: 无授权直入路由被拦, settled authorized passes, unsettled pends", () => {
  const blocked = pageBlockReason(pagesetByKey("supply-chain.cp"), "pages/cp/home", {});
  assert.match(blocked, /未开通/);

  const cpGrants = parsePagesetAuth({
    pagesets: [
      { key: "supply-chain.cp", grants: ["waybill.read", "waybill.accept", "dock.reserve", "pickup.checkin", "pod.report", "freight.statement.read", "ai.chat"] },
    ],
  });
  assert.equal(guardDecision("pages/cp/home", "ready", cpGrants), "allowed");
  assert.equal(guardDecision("pages/cp/home", "ready", {}), "blocked");
  // Direct URL entry while the read is still in flight/failed: pending —
  // render nothing, never flash the page.
  assert.equal(guardDecision("pages/cp/home", "unknown", {}), "pending");
  assert.equal(guardDecision("pages/cp/home", "loading", {}), "pending");
  assert.equal(guardDecision("pages/cp/home", "error", {}), "pending");
  // Base pages bypass the guard entirely.
  assert.equal(guardDecision("pages/chat/index", "unknown", {}), "allowed");
  // Page-level grant block carries its own explainable reason: key authorized
  // but pickup.checkin not granted for that page.
  const pageBlock = pageBlockReason(
    pagesetByKey("supply-chain.cp"),
    "pages/cp/pickup-checkin",
    parsePagesetAuth({ pagesets: [{ key: "supply-chain.cp", grants: ["waybill.read", "waybill.accept", "dock.reserve", "pod.report", "freight.statement.read", "ai.chat"] }] }),
  );
  assert.match(pageBlock, /无该页面权限/);
});

test("confirm-gate default timeout wording stays the cron discipline", () => {
  assert.equal(DEFAULT_TIMEOUT_MESSAGE, "服务器未确认，请检查连接后重试");
});
