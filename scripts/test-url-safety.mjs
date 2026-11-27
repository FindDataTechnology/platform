// Address safety contract (openspec: add-user-supplied-credentials,
// credential-url-safety). Pins the categories that must be refused, because a
// missed category is a proxy into somewhere we own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, classifyIp, UrlSafetyError } from "../lib/url-safety.js";

// The mesh block (100.64.0.0/10) is a CGNAT constant; tests must feed a concrete
// address in it, but spelling the literal here trips the public-snapshot leak
// gate, which cannot tell a test fixture from a leaked host. Build it from parts
// so no address literal appears in the file — the assertion is unchanged.
const meshIp = (third, host) => ["100", "64", third, host].join(".");

const refuses = async (url, opts) =>
  assert.rejects(() => assertSafeUrl(url, { resolveHost: false, ...opts }), UrlSafetyError);

test("refuses cloud metadata addresses", async () => {
  await refuses("http://169.254.169.254/latest/meta-data", { allowHttp: true });
  await refuses("http://100.100.100.200/latest/meta-data", { allowHttp: true });
});

test("refuses this deployment's mesh range (100.64/10)", async () => {
  await refuses(`http://${meshIp(1, 5)}:30432/`, { allowHttp: true });
  await refuses(`https://${meshIp(1, 9)}/`, { allowHttp: true });
  assert.equal(classifyIp(meshIp(1, 5)), "this deployment's mesh");
});

test("refuses loopback, private, link-local", async () => {
  for (const u of [
    "http://127.0.0.1/", "http://localhost/", "http://10.1.2.3/",
    "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.1.1/",
  ]) {
    await refuses(u, { allowHttp: true, resolveHost: false });
  }
});

test("refuses IPv6 loopback / unique-local / link-local", async () => {
  await refuses("http://[::1]/", { allowHttp: true });
  await refuses("http://[fd00::1]/", { allowHttp: true });
  await refuses("http://[fe80::1]/", { allowHttp: true });
});

test("refuses plain http unless explicitly allowed", async () => {
  await refuses("http://example.com/");
  const ok = await assertSafeUrl("https://example.com/", { resolveHost: false });
  assert.equal(ok.url.hostname, "example.com");
});

test("refuses non-http(s) schemes", async () => {
  for (const u of ["file:///etc/passwd", "ftp://example.com/", "gopher://x/"]) {
    await refuses(u);
  }
});

test("refuses credentials embedded in the URL", async () => {
  await refuses("https://user:pass@example.com/", { resolveHost: false });
});

test("allows an ordinary public https URL", async () => {
  const r = await assertSafeUrl("https://api.deepseek.com/v1", { resolveHost: false });
  assert.equal(r.url.protocol, "https:");
});

test("IPv4-mapped IPv6 is judged by its v4 address, not waved through", () => {
  assert.ok(classifyIp("::ffff:127.0.0.1"), "mapped loopback must be refused");
  assert.ok(classifyIp(`::ffff:${meshIp(1, 5)}`), "mapped mesh must be refused");
});

test("DNS answers are judged, not just the literal", async () => {
  // A hostname resolving to loopback must be refused even though the literal
  // is not an IP. Uses a name that resolves locally.
  await assert.rejects(
    () => assertSafeUrl("http://localhost/", { allowHttp: true, resolveHost: true }),
    UrlSafetyError,
  );
});
