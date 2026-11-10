// add-knowledge-memory-surface 3.1: dataSources accept a knowledge-collection
// ref (`library:<id>`) as a third kind, and a dangling/invisible id is refused
// BY NAME when a resolver is supplied. This module stays DB-free; the resolver
// callback is the caller's DB-backed check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dataSourceFindings } from "../server/blueprint-validate.js";

const content = (dataSources) => ({ boundary: {}, fleet: {}, dataSources });

test("a library:<id> ref passes the shape gate", () => {
  const f = dataSourceFindings(content([{ ref: "library:col-123" }]));
  assert.deepEqual(f, []);
});

test("a registry/logical name still passes (no regression)", () => {
  assert.deepEqual(dataSourceFindings(content([{ ref: "websearch" }])), []);
});

test("endpoints and credentials are still refused", () => {
  const f = dataSourceFindings(content([{ ref: "https://evil.example/x" }]));
  assert.equal(f.length, 1);
  assert.match(f[0].error, /no endpoints, no credentials/);
});

test("a dangling library id is refused by name when a resolver is given", () => {
  const f = dataSourceFindings(content([{ ref: "library:missing-1" }]), (id) =>
    id === "missing-1" ? "no such collection in this deployment" : true,
  );
  assert.equal(f.length, 1);
  assert.match(f[0].error, /library:missing-1/);
  assert.match(f[0].error, /no such collection/);
});

test("a visible library id passes resolution", () => {
  const f = dataSourceFindings(content([{ ref: "library:col-ok" }]), () => true);
  assert.deepEqual(f, []);
});

test("without a resolver the shape alone decides (no false rejection)", () => {
  assert.deepEqual(dataSourceFindings(content([{ ref: "library:anything-ok" }])), []);
});

test("malformed library refs are refused (empty id, bad chars)", () => {
  assert.equal(dataSourceFindings(content([{ ref: "library:" }])).length, 1);
  assert.equal(dataSourceFindings(content([{ ref: "library:has space" }])).length, 1);
});
