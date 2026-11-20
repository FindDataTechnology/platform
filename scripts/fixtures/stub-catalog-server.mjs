// Minimal stand-in for the facet public read faces, so the plaza exporter's
// NETWORK path can be exercised without production. It serves only what
// runFresh touches: packs / marketplace.json / skills / mcp / facades /
// data-anchors.
//
// `dropped` / `coerced` reproduce the shape facet started returning on
// 2026-11-14. A non-zero counter must turn the export red — that is the whole
// point of the fixture: the fixture path proves the rule, this proves the
// wiring (a typo between the response and the gate would pass a fixture-only
// test suite).
//
// Usable two ways: imported by scripts/test-plaza-export.mjs via
// createStubServer(), or run directly for a manual smoke:
//   node scripts/fixtures/stub-catalog-server.mjs --dropped 3   # prints port
import http from "node:http";
import { pathToFileURL } from "node:url";

export function createStubServer({ dropped = 0, coerced = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/packs") return json({ total: 0, page: 1, pageSize: 100, packs: [] });
    if (url.pathname === "/api/marketplace/marketplace.json") return json({ plugins: [] });
    if (url.pathname === "/api/skills-catalog") return json({ skills: [] });
    if (url.pathname === "/api/mcp-catalog") return json({ servers: [] });
    if (url.pathname === "/api/facades-catalog") return json({ facades: [], dropped: 0, coerced: 0, viewer: "anonymous" });
    if (url.pathname === "/api/data-anchors-catalog") {
      return json({ anchors: [], dropped, coerced, as_of: new Date().toISOString() });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => Number(process.argv[process.argv.indexOf(name) + 1]) || 0;
  const stub = createStubServer({ dropped: arg("--dropped"), coerced: arg("--coerced") });
  stub.listen().then((base) => {
    process.stdout.write(`${base}\n`);
  });
}
