# artifact-contract Delta

## Purpose
The platform teaches every conversational persona — built-in, pack, custom, or remote — a single output-form contract for chat artifacts (charts, files), so model output reliably uses the forms the platform can capture, serve, and render delivery affordances for. This capability exists because nothing propagated these conventions before, and models improvised counterproductive delivery answers.

## ADDED Requirements

### Requirement: The artifact contract reaches every persona
The platform SHALL deliver an artifact output contract into the model-visible context of every conversational persona: built-in preset sessions, pack personas, custom presets, and remote catalog agents. Delivery SHALL NOT depend on any pack's or preset's own prompt content, and SHALL remain in effect after agent restarts and preset switches.

#### Scenario: built-in preset session carries the contract
- **WHEN** a session starts on the built-in standard preset (the deployment default persona)
- **THEN** the model-visible context for that session contains the artifact contract

#### Scenario: pack persona carries the contract regardless of pack content
- **WHEN** a pack is installed or updated and a session starts on one of its personas
- **THEN** the artifact contract is present even though the pack's own prompt never mentions it

#### Scenario: custom preset session carries the contract
- **WHEN** a user assembles a custom preset and starts a session on it
- **THEN** the artifact contract is present

#### Scenario: remote agent turn carries the contract
- **WHEN** a remote catalog agent handles a turn
- **THEN** the system message delivered with the turn includes the artifact contract

#### Scenario: contract survives restart and preset switch
- **WHEN** the agent process restarts, or the user switches presets mid-session lifetime
- **THEN** subsequent sessions and turns still carry the artifact contract

### Requirement: Contract content fixes artifact output forms
The contract SHALL instruct that: (a) charts appear as fenced `echarts` blocks with a JSON option body; (b) files are referenced by markdown links with workspace-relative paths; (c) `data:` URI links are not emitted; (d) the model SHALL NOT claim inability to deliver workspace files, and SHALL NOT direct users to UI affordances whose existence it has not been told.

#### Scenario: contract text names the conventions
- **WHEN** the delivered contract text is inspected
- **THEN** it names the echarts fence form for charts, workspace-relative markdown links for files, the prohibition of `data:` URI links, and the delivery-ability clause

#### Scenario: contract text stays delivery-focused
- **WHEN** the contract is authored or revised
- **THEN** it remains a short instruction layer (baseline-skill sized), not a general prompting style guide
