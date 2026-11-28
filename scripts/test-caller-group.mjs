#!/usr/bin/env node
// ── Registry caller-group assignment (add-agent-platform-ops D5, C-lite) ─────
//
// The connect flow must give the user's registry account the invoke-only
// caller group under the SAME username the auth server's DB fallback looks up
// (the token's subject claim), with the record upserted through the live API
// shapes: GET → PATCH {groups: merged} when the record exists, POST
// {username, groups} when it does not, and a JSON body either way.
//
//   node --test scripts/test-caller-group.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Env before module import (paths are resolved at module load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "caller-group-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");

const { assignCallerGroup, marketAdminFetch, usernameFromToken } = await import("../caller-group.js");

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

test("username comes from the minted token's subject claim", () => {
  assert.equal(
    usernameFromToken(jwt({ sub: "lawbenchtestadmin", preferred_username: "lawbenchtestadmin", groups: [] })),
    "lawbenchtestadmin",
  );
  assert.equal(usernameFromToken(jwt({ preferred_username: "alice" })), "alice");
  assert.equal(usernameFromToken("opaque-token"), null);
  assert.equal(usernameFromToken(undefined), null);
});

test("absent record is created with the caller group (POST)", async () => {
  const calls = [];
  const adminFetch = async (p, init = {}) => {
    calls.push({ p, init });
    if (init.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ username: "u1" }), { status: 201 });
  };
  const out = await assignCallerGroup({ email: "u1@x.test", token: jwt({ sub: "u1" }), adminFetch });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.username, "u1");
  const post = calls.find((c) => c.init.method === "POST");
  assert.deepEqual(post.init.body, { username: "u1", groups: ["paas-agent-callers"], email: "u1@x.test" });
});

test("existing record is merged, not replaced (PATCH)", async () => {
  const calls = [];
  const adminFetch = async (p, init = {}) => {
    calls.push({ p, init });
    if (init.method === "GET") return new Response(JSON.stringify({ username: "u1", groups: ["legal"] }), { status: 200 });
    return new Response(JSON.stringify({ username: "u1" }), { status: 200 });
  };
  const out = await assignCallerGroup({ email: "u1@x.test", token: jwt({ sub: "u1" }), adminFetch });
  assert.equal(out.changed, true);
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert.deepEqual(patch.init.body, { groups: ["legal", "paas-agent-callers"] });
  assert.equal(calls.some((c) => c.init.method === "POST"), false);
});

test("already-grouped record is a no-op (no writes)", async () => {
  const calls = [];
  const adminFetch = async (p, init = {}) => {
    calls.push({ p, init });
    return new Response(JSON.stringify({ username: "u1", groups: ["paas-agent-callers"] }), { status: 200 });
  };
  const out = await assignCallerGroup({ email: "u1@x.test", token: jwt({ sub: "u1" }), adminFetch });
  assert.equal(out.changed, false);
  assert.equal(calls.filter((c) => c.init.method !== "GET").length, 0);
});

test("without a decodable token the email listing resolves the username", async () => {
  const calls = [];
  const adminFetch = async (p, init = {}) => {
    calls.push({ p, init });
    if (p === "/api/iam/user-groups" && init.method === "GET") {
      return new Response(JSON.stringify({ total: 1, items: [{ username: "alice-registry", email: "alice@x.test" }] }), { status: 200 });
    }
    if (init.method === "GET") return new Response("not found", { status: 404 });
    return new Response("{}", { status: 201 });
  };
  const out = await assignCallerGroup({ email: "alice@x.test", token: "opaque", adminFetch });
  assert.equal(out.username, "alice-registry");
  const post = calls.find((c) => c.init.method === "POST");
  assert.equal(post.init.body.username, "alice-registry");
});

test("failures never throw — the connect flow proceeds", async () => {
  const adminFetch = async () => {
    throw new Error("Failed to parse URL from /api/iam/user-groups");
  };
  const out = await assignCallerGroup({ email: "u1@x.test", token: null, adminFetch, log: { warn() {} } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Failed to parse URL/);
});

test("marketAdminFetch serializes object bodies as JSON with the bearer", async () => {
  const seen = [];
  const f = marketAdminFetch({
    registryUrl: "https://registry.example.test/",
    token: "svc-token",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    },
  });
  await f("/api/iam/user-groups/x", { method: "PATCH", body: { groups: ["g"] } });
  assert.equal(seen[0].url, "https://registry.example.test/api/iam/user-groups/x");
  assert.equal(seen[0].init.body, JSON.stringify({ groups: ["g"] }));
  assert.equal(seen[0].init.headers["Content-Type"], "application/json");
  assert.equal(seen[0].init.headers.Authorization, "Bearer svc-token");
  // String bodies pass through untouched (no double encoding).
  await f("/x", { method: "POST", body: "raw" });
  assert.equal(seen[1].init.body, "raw");
});

// 上面那条注入 fetchImpl，因此它验的是「调用方给的 fetch 收到什么」——默认分支从没被走过。
// 生产唯一调用点（server/routes/registry.js 的 C-lite 分支）不传 fetchImpl，所以必须单测
// 默认分支：否则 `base + base + path` 这种缺陷在单测里天然不可见，只在线上报
// `Failed to parse URL from http://…:4599http://…:4599/api/iam/user-groups`。
test("marketAdminFetch 默认分支只拼一次 base（不注入 fetchImpl）", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  try {
    const f = marketAdminFetch({ registryUrl: "https://registry.example.test/", token: "svc-token" });
    await f("/api/iam/user-groups/u1", { method: "GET" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://registry.example.test/api/iam/user-groups/u1");
  // 显式断言「没有第二个 base」：只比等号时，写成 base+base 的缺陷会给出明显更长的串，
  // 但若有人把 registryUrl 也变成相对量，等号仍会过——这条把重复本身点出来。
  assert.ok(
    !seen[0].url.includes("registry.example.test" + "https://"),
    `base 被拼了两次: ${seen[0].url}`,
  );
});