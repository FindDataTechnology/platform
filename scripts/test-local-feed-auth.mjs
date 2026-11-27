// local-agent-registry-feed — the loopback half of the feed credential.
//
// The spec's "无令牌请求被拒" scenario says a missing/wrong bearer answers 401
// AND the feed is loopback-bound. The token-less branch is the one that can
// silently widen: the auth gate exempts `/local-registry/` wholesale because
// the route authenticates itself, so when no token was ever minted (dev /
// headless cell) "no check" would mean "open to whatever interface the cell
// binds". A container running HOST=0.0.0.0 would then serve the roster — pack
// identity, seat tag, per-agent topology — to the whole pod network.
//
// The fix makes the documented dev posture literal: token-less admits
// loopback only. This file pins both halves through the real router, with the
// peer address supplied by a wrapper middleware (the router reads
// req.socket.remoteAddress, which a listening socket cannot vary per case).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "fd-local-feed-"));

const { createLocalAgentFeed } = await import("../server/local-agent-feed.js");

// Serve the router behind a middleware that lets each request declare the peer
// address the gate should see. Everything else (path, verb, headers) goes
// through the real router code.
async function boot(env) {
  const app = express();
  app.use((req, _res, next) => {
    const fake = req.headers["x-test-remote"];
    if (fake) {
      Object.defineProperty(req, "socket", {
        value: { remoteAddress: String(fake) },
        configurable: true,
      });
    }
    next();
  });
  app.use(createLocalAgentFeed({ env, runnerId: null, seatTag: false }));
  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const get = (base, path, { remote, token } = {}) =>
  fetch(base + path, {
    headers: {
      ...(remote ? { "x-test-remote": remote } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

test("feed: no token minted ⇒ loopback is admitted (dev posture stays usable)", async () => {
  const { base, close } = await boot({});
  try {
    const res = await get(base, "/api/agents", { remote: "127.0.0.1" });
    // The store may not be ready in this throwaway home; what matters is that
    // the credential layer let the caller through (not 401).
    assert.notEqual(res.status, 401, `loopback must not be challenged, got ${res.status}`);
  } finally {
    await close();
  }
});

test("feed: no token minted ⇒ each loopback address form is admitted", async () => {
  const { base, close } = await boot({});
  try {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await get(base, "/api/agents", { remote });
      assert.notEqual(res.status, 401, `${remote} must not be challenged`);
    }
  } finally {
    await close();
  }
});

test("feed: no token minted ⇒ a non-loopback peer is refused (this is the defect)", async () => {
  const { base, close } = await boot({});
  try {
    for (const remote of ["10.1.2.3", "192.168.1.50", "172.16.0.9"]) {
      const res = await get(base, "/api/agents", { remote });
      assert.equal(res.status, 401, `${remote} must be refused, got ${res.status}`);
    }
  } finally {
    await close();
  }
});

test("feed: a minted token is still required from loopback, and a wrong one is 401", async () => {
  const { base, close } = await boot({ WANXING_LOCAL_FEED_TOKEN: "seat-token" });
  try {
    const missing = await get(base, "/api/agents", { remote: "127.0.0.1" });
    assert.equal(missing.status, 401);
    const wrong = await get(base, "/api/agents", { remote: "127.0.0.1", token: "nope" });
    assert.equal(wrong.status, 401);
    const right = await get(base, "/api/agents", { remote: "127.0.0.1", token: "seat-token" });
    assert.notEqual(right.status, 401);
  } finally {
    await close();
  }
});

test("feed: a minted token also admits a non-loopback caller that presents it", async () => {
  // The token is the credential once one exists; the address check is only the
  // stand-in for it in the token-less dev posture. Pinned so a future tightening
  // does not silently break a runner that reaches its own cell over a non-
  // loopback interface.
  const { base, close } = await boot({ WANXING_LOCAL_FEED_TOKEN: "seat-token" });
  try {
    const res = await get(base, "/api/agents", { remote: "10.1.2.3", token: "seat-token" });
    assert.notEqual(res.status, 401);
  } finally {
    await close();
  }
});
