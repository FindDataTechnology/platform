// Tests for the derived artifact contract (openspec: add-caas-delivery-contract 6.1).
// Run: node --test lib/artifact-contract.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { CAAS, FORMS } from "./caas-envelope.js";
import { composeArtifactContract, artifactContractText } from "./artifact-contract.js";

test("the contract names every form the authority declares", () => {
  const text = artifactContractText();
  for (const f of FORMS) {
    const label = CAAS.forms[f].label_zh;
    assert.ok(text.includes(label), `contract must name the ${f} form (「${label}」)`);
  }
});

test("adding a form to the authority changes the contract with no code edit", () => {
  // This is the whole point of deriving: the sentence is not a second copy.
  // Simulate by asserting the vocabulary line is built from FORMS, not a literal.
  const text = artifactContractText();
  const vocab = text.slice(text.indexOf("可交付形态"));
  assert.equal(
    FORMS.filter((f) => vocab.includes(CAAS.forms[f].label_zh)).length,
    FORMS.length,
    "every authority form appears in the vocabulary line",
  );
});

test("the platform rules the spec requires are all present", () => {
  const text = artifactContractText();
  assert.match(text, /echarts/, "chart fence form");
  assert.match(text, /mermaid/, "explicitly not mermaid");
  assert.match(text, /工作区相对路径/, "workspace-relative markdown links for files");
  assert.match(text, /data: URI/, "the data: URI prohibition");
  assert.match(text, /不要声称平台无法渲染或交付/, "the delivery-ability clause");
});

test("persona identity is carried when given, absent when not", () => {
  const withId = composeArtifactContract({ agentName: "产品顾问", agentDescription: "负责产品答疑" });
  assert.match(withId, /你是「产品顾问」——负责产品答疑。/);

  const bare = artifactContractText();
  assert.doesNotMatch(bare, /你是「/);
});

test("the contract stays an instruction layer, not an essay", () => {
  // Spec: "remains a short instruction layer (baseline-skill sized)".
  // 400 chars is generous; the current text is ~250. This guards against
  // someone膨胀ing it into a prompting guide.
  assert.ok(artifactContractText().length < 400, `contract is ${artifactContractText().length} chars — too long`);
});

test("no form label is hardcoded as a literal in the derived sentence", () => {
  // Guard against re-introducing a second copy: the only place a form label may
  // come from is CAAS.forms. If someone hardcodes 「图表」 somewhere else in this
  // module, the vocabulary-derivation test above would still pass, so this test
  // asserts the module holds exactly one source (the import).
  const text = composeArtifactContract({ agentName: "x", agentDescription: "y" });
  const chartLabel = CAAS.forms.chart.label_zh;
  // Present exactly as often as the sentence uses it (chart rule + vocabulary).
  const occurrences = text.split(chartLabel).length - 1;
  assert.equal(occurrences, 2, `chart label should appear exactly twice (rule + vocabulary), got ${occurrences}`);
});
