// Stub cell for scripts/test-session-share.mjs — a minimal server.js
// stand-in with just enough chat-history to exercise share ownership:
//   GET /api/chat-history/sessions/sess-owned-1  → 200, a two-turn session
//   GET /api/chat-history/sessions/<anything>    → 404
// Answers every request as the identity the gateway forwarded (echoed in the
// session payload) so tests can assert which cell/identity served a read.

import http from "node:http";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";

const port = Number(process.env.PORT || 0);
const OWNED = "sess-owned-1";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const email = req.headers["x-forwarded-email"] ?? null;
  const m = req.url?.match(/^\/api\/chat-history\/sessions\/([^/]+)$/);
  if (req.method === "GET" && m) {
    if (m[1] === OWNED) {
      return res.end(
        JSON.stringify({
          id: OWNED,
          title: "Owned session",
          messages: [
            { role: "user", content: "hello from the owner" },
            { role: "assistant", content: "hi there" },
          ],
          servedFor: email,
          hasSecret: Boolean(req.headers[GATEWAY_SECRET_HEADER]),
        }),
      );
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  res.status(200).end(JSON.stringify({ stub: true, url: req.url, email }));
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`share-test-cell ready on ${port}\n`));
