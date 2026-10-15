#!/usr/bin/env node
// ── Cell auth path advertisement (fix-web-signout-dead-route, task 1.2) ─────
//
// Boots the REAL cell registry against an env-dumping stub, so the auth-path
// contract is proven without a full server boot: cells spawned by the gateway
// must advertise the gateway's own login/logout routes in their env (the
// gateway is the sole Logto client; no /oauth2/* edge exists in this
// topology), overriding the forward-auth-era defaults the cell would
// otherwise report from AUTH_LOGOUT_PATH/AUTH_LOGIN_PATH.
//
//   node --test scripts/test-cell-auth-paths.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";

const STUB = `
import http from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const dir = path.dirname(process.env.PLATFORM_DATA_DIR);
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "spawn-dump.json"), JSON.stringify({
  authLoginPath: process.env.AUTH_LOGIN_PATH || null,
  authLogoutPath: process.env.AUTH_LOGOUT_PATH || null,
}));
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT, "127.0.0.1");
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readDump(root, email) {
  const file = path.join(root, userIdFor(email), "spawn-dump.json");
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`spawn dump never appeared for ${email}: ${file}`);
}

test("gateway-spawned cells advertise the gateway's auth entry/exit paths", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-auth-paths-")));
  const stub = path.join(root, "stub-cell.mjs");
  await writeFile(stub, STUB);

  const registry = createCellRegistry({
    dataRoot: path.join(root, "cells"),
    secret: "test-secret",
    startTimeoutMs: 15_000,
    idleReapSecs: 0,
    serverEntry: stub,
    // A deployment that still carries the edge-era defaults at the gateway
    // level must not leak them into cells: the spawner's own values win.
    env: { ...process.env, AUTH_LOGOUT_PATH: "/oauth2/sign_out" },
  });

  try {
    const A = "alice@cell-auth-paths.test";
    await registry.ensure({ email: A, groups: [] });
    const a = await readDump(path.join(root, "cells"), A);

    assert.equal(a.authLogoutPath, "/api/auth/logout");
    assert.equal(a.authLoginPath, "/auth/login");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
