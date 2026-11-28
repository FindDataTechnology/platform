// Fence tokenizer + chart routing tests (task 1.1): the token stream is what
// the renderer routes on, so these pin the language marker, the open/closed
// state (streaming), and the chart-option acceptance rules.

import test from "node:test";
import assert from "node:assert/strict";
import { chartOptionFromFence, tokenizeFences } from "../src/lib/markdown-fences.ts";

const BAR = JSON.stringify({ xAxis: { type: "category", data: ["a"] }, series: [{ type: "bar", data: [1] }] });

test("keeps the language marker of a closed fence", () => {
  const tokens = tokenizeFences(`prose\n\`\`\`echarts\n${BAR}\n\`\`\`\ntail`);
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["text", "code", "text"],
  );
  const code = tokens[1];
  assert.equal(code.kind, "code");
  assert.equal(code.lang, "echarts");
  assert.equal(code.closed, true);
  assert.equal(code.body, `${BAR}\n`);
});

test("a fence with no language keeps an empty marker", () => {
  const [code] = tokenizeFences("```\nplain\n```").filter((t) => t.kind === "code");
  assert.equal(code.lang, "");
  assert.equal(code.body, "plain\n");
  assert.equal(code.closed, true);
});

test("a streaming (unclosed) fence stays code and reports closed=false", () => {
  const tokens = tokenizeFences(`\`\`\`echarts\n{"series":[{"type":"line"`);
  const code = tokens.at(-1);
  assert.equal(code.kind, "code");
  assert.equal(code.closed, false);
  // …and it must not be routed to a chart mid-stream.
  assert.equal(chartOptionFromFence(code), null);
});

test("two fences in one message stay two code tokens", () => {
  const tokens = tokenizeFences("```js\na\n```\nmid\n```echarts\n" + BAR + "\n```");
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["code", "text", "code"],
  );
  assert.equal(tokens[2].lang, "echarts");
});

test("chart option accepts a plain object, rejects the failure shapes", () => {
  const [code] = tokenizeFences(`\`\`\`echarts\n${BAR}\n\`\`\``).filter((t) => t.kind === "code");
  assert.deepEqual(chartOptionFromFence(code), JSON.parse(BAR));

  const bad = (body) => {
    const [t] = tokenizeFences("```echarts\n" + body + "\n```").filter((x) => x.kind === "code");
    return chartOptionFromFence(t);
  };
  assert.equal(bad("not json"), null);
  assert.equal(bad("[1,2,3]"), null);
  assert.equal(bad("42"), null);
  assert.equal(bad("null"), null);
});

test("other languages never route to a chart", () => {
  const [code] = tokenizeFences("```json\n" + BAR + "\n```").filter((t) => t.kind === "code");
  assert.equal(code.lang, "json");
  assert.equal(chartOptionFromFence(code), null);
});