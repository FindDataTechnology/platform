// Unit tests for the mini-program markdown parser (openspec:
// add-miniprogram-client, task 5.2's rendering contract). Runs standalone
// (`npm --prefix miniapp run test:markdown`) and via node --test directly.

import test from "node:test";
import assert from "node:assert/strict";
import { parseChartOption, parseInline, parseMarkdown } from "./markdown.ts";

test("headings and paragraphs", () => {
  const nodes = parseMarkdown("# Title\n\nsome *body*\ntext\n\n### Deep");
  assert.equal(nodes[0].kind, "heading");
  assert.equal(nodes[0].level, 1);
  assert.deepEqual(nodes[0].inlines, [{ type: "text", text: "Title" }]);
  assert.equal(nodes[1].kind, "paragraph");
  assert.deepEqual(nodes[1].inlines, [
    { type: "text", text: "some " },
    { type: "em", text: "body" },
    { type: "text", text: "\ntext" },
  ]);
  assert.equal(nodes[2].kind, "heading");
  assert.equal(nodes[2].level, 3);
});

test("fenced code with language is verbatim (no inline parsing)", () => {
  const nodes = parseMarkdown("```js\nconst a = 1;\n**not bold**\n```\n");
  assert.deepEqual(nodes, [{ kind: "code", lang: "js", text: "const a = 1;\n**not bold**" }]);
});

test("unterminated fence closes at EOF instead of throwing", () => {
  const nodes = parseMarkdown("```\nstill streaming");
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], { kind: "code", lang: "", text: "still streaming" });
});

test("lists: unordered and ordered", () => {
  const ul = parseMarkdown("- one\n- two **b**\n- three");
  assert.equal(ul.length, 1);
  assert.equal(ul[0].kind, "list");
  assert.equal(ul[0].ordered, false);
  assert.equal(ul[0].items.length, 3);

  const ol = parseMarkdown("1. first\n2. second");
  assert.equal(ol[0].ordered, true);
  assert.equal(ol[0].items.length, 2);
});

test("blockquote joins lines", () => {
  const nodes = parseMarkdown("> line one\n> line two");
  assert.deepEqual(nodes, [{ kind: "quote", inlines: [{ type: "text", text: "line one line two" }] }]);
});

test("pipe table with separator", () => {
  const nodes = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  assert.equal(nodes.length, 1);
  const t = nodes[0];
  assert.equal(t.kind, "table");
  assert.deepEqual(t.header, [
    [{ type: "text", text: "a" }],
    [{ type: "text", text: "b" }],
  ]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[1], [
    [{ type: "text", text: "3" }],
    [{ type: "text", text: "4" }],
  ]);
});

test("hr, links, inline code", () => {
  const nodes = parseMarkdown("---\n\nsee [docs](https://example.com/x) and `npm i`");
  assert.equal(nodes[0].kind, "hr");
  assert.deepEqual(nodes[1].inlines, [
    { type: "text", text: "see " },
    { type: "link", text: "docs", href: "https://example.com/x" },
    { type: "text", text: " and " },
    { type: "code", text: "npm i" },
  ]);
});

test("inline precedence: code span beats emphasis", () => {
  assert.deepEqual(parseInline("`*x*`"), [{ type: "code", text: "*x*" }]);
  assert.deepEqual(parseInline("**b**"), [{ type: "strong", text: "b" }]);
});

test("malformed input never throws", () => {
  for (const src of ["", "```", "| a |", "[link](", "*", "#", "- ", "> ", "**"]) {
    assert.doesNotThrow(() => parseMarkdown(src));
  }
});

test("chart option parsing: only a JSON object qualifies", () => {
  assert.deepEqual(parseChartOption('{"xAxis":{}}'), { xAxis: {} });
  assert.equal(parseChartOption("not json"), null);
  assert.equal(parseChartOption("[1,2]"), null);
  assert.equal(parseChartOption('"str"'), null);
});
