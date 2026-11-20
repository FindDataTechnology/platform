// The landing gate's decision (openspec: add-role-landing-board). The server
// resolved the landing; the only client-side question is whether a board's
// credential is connected. Every branch below is a behaviour the spec names.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boardLineOf, navSlugOf, resolveLandingTarget } from "../web/src/lib/landing.ts";

const base = {
  lineBoardsEnabled: true,
  nav: ["chat", "knowledge", "resources", "memory", "agents", "apps", "fleets"],
  // Mirrors appCatalog.boardAvailable: a board with no credential requirement
  // is always available; the rest need a connected credential.
  boardAvailable: (line, states) =>
    line === "wanxing" || (states?.[`line-${line}`] ?? "disconnected") === "connected",
  needsCredential: (line) => line !== "wanxing",
};

test("boardLineOf / navSlugOf split the two landing shapes", () => {
  assert.equal(boardLineOf("/boards/lex"), "lex");
  assert.equal(boardLineOf("/fleets"), null);
  assert.equal(navSlugOf("/fleets"), "fleets");
  assert.equal(navSlugOf("/boards/wire"), null);
  // A deeper board path is not a landing (the validator would have rejected it).
  assert.equal(boardLineOf("/boards/lex/x"), null);
});

test("no landing lands on chat", () => {
  assert.equal(resolveLandingTarget({ ...base, landing: "/chat", states: {} }), "/chat");
});

test("a visible nav landing is honoured", () => {
  assert.equal(resolveLandingTarget({ ...base, landing: "/fleets", states: {} }), "/fleets");
});

test("a nav landing the layout hid falls back to chat", () => {
  assert.equal(
    resolveLandingTarget({ ...base, landing: "/fleets", states: {}, nav: ["chat", "agents"] }),
    "/chat",
  );
});

test("an older server (null nav) trusts the server's nav landing", () => {
  assert.equal(resolveLandingTarget({ ...base, landing: "/fleets", states: {}, nav: null }), "/fleets");
});

test("a connected board landing is honoured", () => {
  assert.equal(
    resolveLandingTarget({ ...base, landing: "/boards/lex", states: { "line-lex": "connected" } }),
    "/boards/lex",
  );
});

test("an unconnected credential board lands on /apps — the page that unblocks it", () => {
  const target = resolveLandingTarget({ ...base, landing: "/boards/lex", states: {} });
  assert.equal(target, "/apps");
  // A stale credential is "not connected" for the board's purposes.
  assert.equal(
    resolveLandingTarget({ ...base, landing: "/boards/wire", states: { "line-wire": "stale" } }),
    "/apps",
  );
});

test("a connection read that failed (null) also lands on /apps", () => {
  assert.equal(resolveLandingTarget({ ...base, landing: "/boards/lex", states: null }), "/apps");
});

test("a board with no credential requirement is honoured without a connection read", () => {
  assert.equal(resolveLandingTarget({ ...base, landing: "/boards/wanxing", states: null }), "/boards/wanxing");
});

test("the boards switch off disqualifies a board landing", () => {
  assert.equal(
    resolveLandingTarget({ ...base, landing: "/boards/lex", states: { "line-lex": "connected" }, lineBoardsEnabled: false }),
    "/chat",
  );
});
