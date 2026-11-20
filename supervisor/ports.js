// ── Free-port assignment for spawned servers ────────────────────────────────
//
// The supervisor assigns each spawned port-speaking server a free localhost
// port at launch (Decision D9) to avoid collisions with the user's existing
// services (e.g. a `npm start` dev server on :3000). The chosen port is passed
// to the child as PORT and used to build the URL the BrowserWindow loads.

import net from "node:net";

export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
