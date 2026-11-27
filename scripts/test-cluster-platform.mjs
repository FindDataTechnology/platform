#!/usr/bin/env node
// Test script for agent cluster platform (agent-cluster-platform)
// Tests pack manifest validation, catalog marking, and cluster API

import { validatePackManifest } from "../lib/pack-manifest.js";

console.log("=== Agent Cluster Platform Tests ===\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${err.message}`);
    failed++;
  }
}

// Test 1: Valid cluster metadata
test("Valid cluster metadata", () => {
  const manifest = {
    name: "Test Pack",
    description: "A test pack",
    skills: [{ name: "test-skill", description: "Test", content: "# Test" }],
    agents: [
      { id: "finance-bot", name: "Finance Bot", persona: "You are a finance bot" },
      { id: "data-analyst", name: "Data Analyst", persona: "You are a data analyst" },
      { id: "report-generator", name: "Report Generator", persona: "You generate reports" }
    ],
    cluster: {
      name: "Finance Analyst Cluster",
      description: "Financial analysis agents",
      defaultAgents: ["finance-bot", "data-analyst"],
      optionalAgents: ["report-generator"],
      schedulingPolicy: { maxConcurrentRuns: 3 }
    }
  };
  
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

// Test 2: Missing required cluster fields
test("Missing required cluster fields rejected", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }],
    cluster: { name: "Test" } // missing description and defaultAgents
  };
  
  const errors = validatePackManifest(manifest);
  if (errors.length === 0) {
    throw new Error("Expected validation errors for missing fields");
  }
  
  const hasDescriptionError = errors.some(e => e.entry?.includes("description"));
  const hasDefaultAgentsError = errors.some(e => e.entry?.includes("defaultAgents"));
  
  if (!hasDescriptionError || !hasDefaultAgentsError) {
    throw new Error(`Expected description and defaultAgents errors, got: ${JSON.stringify(errors)}`);
  }
});

// Test 3: Invalid agent reference in cluster
test("Invalid agent reference rejected", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }],
    cluster: {
      name: "Test",
      description: "T",
      defaultAgents: ["non-existent-agent"]
    }
  };
  
  const errors = validatePackManifest(manifest);
  // The error message is correct, just check that there's an error about the agent ref
  if (errors.length === 0) {
    throw new Error(`Expected validation error for invalid agent reference`);
  }
  
  const hasAgentRefError = errors.some(e => 
    e.error?.includes("non-existent-agent") && e.error.includes("not declared")
  );
  
  if (!hasAgentRefError) {
    throw new Error(`Expected agent reference error, got: ${JSON.stringify(errors)}`);
  }
});

// Test 4: Excessive concurrency limit
test("Excessive concurrency limit rejected", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }],
    cluster: {
      name: "Test",
      description: "T",
      defaultAgents: ["a"],
      schedulingPolicy: { maxConcurrentRuns: 15 } // > 10
    }
  };
  
  const errors = validatePackManifest(manifest);
  const hasConcurrencyError = errors.some(e => 
    e.entry?.includes("maxConcurrentRuns")
  );
  
  if (!hasConcurrencyError) {
    throw new Error(`Expected concurrency error, got: ${JSON.stringify(errors)}`);
  }
});

// Test 5: No cluster (should pass)
test("Pack without cluster passes", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }]
  };
  
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

// Test 6: Duplicate agents between default and optional
test("Duplicate agents between default and optional rejected", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }],
    cluster: {
      name: "Test",
      description: "T",
      defaultAgents: ["a"],
      optionalAgents: ["a"] // duplicate!
    }
  };
  
  const errors = validatePackManifest(manifest);
  // Check that there's an error about the duplicate
  if (errors.length === 0) {
    throw new Error(`Expected validation error for duplicate agents`);
  }
  
  const hasDuplicateError = errors.some(e => 
    e.error?.includes("also in defaultAgents")
  );
  
  if (!hasDuplicateError) {
    throw new Error(`Expected duplicate error, got: ${JSON.stringify(errors)}`);
  }
});

// Test 7: Empty defaultAgents rejected
test("Empty defaultAgents rejected", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [{ id: "a", name: "A", persona: "P" }],
    cluster: {
      name: "Test",
      description: "T",
      defaultAgents: [] // empty!
    }
  };
  
  const errors = validatePackManifest(manifest);
  // Check that there's an error about non-empty array
  if (errors.length === 0) {
    throw new Error(`Expected validation error for empty defaultAgents`);
  }
  
  const hasNonEmptyError = errors.some(e => 
    e.error?.includes("non-empty")
  );
  
  if (!hasNonEmptyError) {
    throw new Error(`Expected non-empty error, got: ${JSON.stringify(errors)}`);
  }
});

// Test 8: Optional agents validation
test("Optional agents validated correctly", () => {
  const manifest = {
    name: "Test Pack",
    skills: [{ name: "test", description: "T", content: "# T" }],
    agents: [
      { id: "a", name: "A", persona: "P" },
      { id: "b", name: "B", persona: "P" }
    ],
    cluster: {
      name: "Test",
      description: "T",
      defaultAgents: ["a"],
      optionalAgents: ["b"] // valid
    }
  };
  
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

// Summary
console.log("\n=== Test Summary ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
  process.exit(0);
}
