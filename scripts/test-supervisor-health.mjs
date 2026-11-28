#!/usr/bin/env node
// Pure-probe guards for the desktop supervisor's health layer
// (optimize-paas-module-audit N-16): `httpProbe` / `tcpProbe` are the only
// liveness verdict sources, but the port suite spawns the whole platform and
// had no dedicated probe test. These drive real loopback sockets — no child
// processes, no dsh, no 30s startup wait.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { httpProbe, tcpProbe } from "../supervisor/health.js";

function listenHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function listenTcp() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("httpProbe accepts 2xx/3xx and rejects 4xx/5xx", async () => {
  const server = await listenHttp((_req, res) => {
    const code = Number(new URL(_req.url, "http://x").searchParams.get("code"));
    res.writeHead(code).end();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const code of [200, 204, 301, 302, 304]) {
      assert.equal(await httpProbe(`${base}/?code=${code}`, 1000), true, `status ${code}`);
    }
    for (const code of [400, 401, 404, 500, 503]) {
      assert.equal(await httpProbe(`${base}/?code=${code}`, 1000), false, `status ${code}`);
    }
  } finally {
    await closeServer(server);
  }
});

test("httpProbe fails closed on malformed URL and connection error", async () => {
  assert.equal(await httpProbe("not a url", 200), false);
  // Port 1 on loopback: nothing listens; the request errors fast.
  assert.equal(await httpProbe("http://127.0.0.1:1/", 300), false);
});

test("httpProbe times out instead of hanging", async () => {
  const server = await listenHttp((_req, _res) => {
    // Deliberately never answer: the probe must settle on its own deadline.
  });
  try {
    const start = Date.now();
    assert.equal(await httpProbe(`http://127.0.0.1:${server.address().port}/`, 60), false);
    assert.ok(Date.now() - start < 2000, "timeout settled promptly");
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

test("tcpProbe accepts an open port and rejects a closed one", async () => {
  const server = await listenTcp();
  try {
    assert.equal(await tcpProbe("127.0.0.1", server.address().port, 1000), true);
    // Port 1 has no listener on loopback.
    assert.equal(await tcpProbe("127.0.0.1", 1, 300), false);
  } finally {
    await closeServer(server);
  }
});
