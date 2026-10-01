// ── Gateway ⇄ cell transport ─────────────────────────────────────────────────
//
// Two directions, one rule: the identity headers a cell trusts are built from
// the gateway's VERIFIED identity and never copied from the client. A caller
// that sets `X-Forwarded-Email` on the way in has that value dropped here, so
// the header a cell sees can only ever be the one the gateway authenticated.

import http from "node:http";
import { connect } from "node:net";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";

// Headers a proxy terminates rather than forwards. `host` is deliberately kept:
// the cell should see the public origin it is serving, not the loopback port.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const IDENTITY_HEADERS = ["x-forwarded-email", "x-forwarded-groups", GATEWAY_SECRET_HEADER];

export function forwardedHeaders(req, user, secret, { keepUpgrade = false } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (IDENTITY_HEADERS.includes(name)) continue;
    if (!keepUpgrade && HOP_BY_HOP.includes(name)) continue;
    headers[name] = value;
  }
  headers["x-forwarded-email"] = user.email;
  headers["x-forwarded-groups"] = (user.groups || []).join(",");
  headers[GATEWAY_SECRET_HEADER] = secret;
  if (keepUpgrade) {
    // A handshake we replay verbatim, so the upgrade headers the client sent
    // are part of the request rather than hop-by-hop noise.
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade || "websocket";
  }
  return headers;
}

export function proxyHttp(req, res, target) {
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.originalUrl || req.url,
      headers: target.headers,
    },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Cell unavailable: ${err.message}` }));
  });
  req.pipe(upstream);
}

// WebSocket stickiness is implicit: the same authenticated user resolves to the
// same cell record every time, so a reconnect lands on the same process while
// it lives. Done at the socket level (replay the request head, then pipe both
// directions) because the `ws` upgrade handshake has to reach the cell intact.
export function proxyUpgrade(req, socket, head, target) {
  const upstream = connect(target.port, target.host);
  const fail = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once("error", fail);
  socket.once("error", fail);
  upstream.once("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(target.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}
