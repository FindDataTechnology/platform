// Stub cell for scripts/test-mp-auth.mjs — NOT a real server.js. Launched by
// the gateway's spawner (CELL_SERVER_ENTRY) with PORT/HOST env; answers every
// request by echoing the identity headers the gateway injected, so the test
// can assert exactly what the cell was told to believe. Also completes WS
// upgrades so the Bearer-on-upgrade path is exercisable.

import http from "node:http";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";

const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      stub: true,
      method: req.method,
      url: req.url,
      // Which cell instance answered (tests assert two identities got two
      // distinct cells, and that a reaped cell cold-started a new one).
      port,
      email: req.headers["x-forwarded-email"] ?? null,
      groups: req.headers["x-forwarded-groups"] ?? null,
      hasGatewaySecret: Boolean(req.headers[GATEWAY_SECRET_HEADER]),
    }),
  );
});
server.on("upgrade", (_req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", () => socket.write("pong"));
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`stub-cell ready on ${port}\n`);
});
