# browser-use Specification

## Purpose

The browser-operation lane: a bundled Playwright MCP server gives the agent page
navigation, inspection, interaction, and screenshot tools on every deployment shape
that can supply a browser runtime — a headless Chromium baked into the hosted-cell
image, or a remote browser reached through a CDP endpoint. Wherever no browser
runtime exists, the whole lane is absent by design (an omitted supply, never a dead
server riding every user's profile), and its tools simply do not appear.

## ADDED Requirements

### Requirement: Bundled browser lane in the bundle manifest

The deployment bundle manifest SHALL declare a `playwright` MCP server entry as
bundled (packager origin `bundled`, `locked` against runtime mutation), driving a
pinned upstream `@playwright/mcp` server with headless launch by default. The lane
SHALL be reachable through the same MCP patch pipeline as every other bundled server
(`dsh-profile.js` `writeMcpPatch`), so its tools register under the
`mcp__playwright__*` naming family and render through the existing tool-use chain
with no frontend change.

#### Scenario: lane tools register on a supplied deployment

- **WHEN** a deployment supplies a browser runtime and the dsh profile boots
- **THEN** the session's tool list SHALL include `mcp__playwright__*` tools
- **AND** tool invocations SHALL flow through the existing tool_start/update/end WS vocabulary

#### Scenario: packager lock honored

- **WHEN** a user or admin attempts to remove or edit the bundled `playwright` entry through the runtime extension API
- **THEN** the bundled-lock rule SHALL refuse the mutation, identical to other bundled entries

### Requirement: Supply gate with three deployment shapes

At patch-write time the lane SHALL resolve exactly one of three shapes:

1. **local**: a browser runtime binary is discoverable at the deployment's declared
   path — the lane is composed with local launch configuration (headless default);
2. **remote**: `BROWSER_CDP_ENDPOINT` is set — the lane is composed to attach to that
   remote browser endpoint and no local runtime is required;
3. **absent**: neither is available, or `BROWSER_LANE=off` — the lane's entry SHALL be
   omitted from the generated patch entirely, as a silent normal state on deployments
   that never supply a browser, logged at info level like other supply omissions.

`BROWSER_LANE=off` SHALL win over both supply forms wherever they exist.

#### Scenario: unsupplied deployment omits the lane

- **WHEN** a deployment has no browser runtime, no remote endpoint, and no explicit flag
- **THEN** the generated patch SHALL contain no `playwright` entry
- **AND** the server SHALL boot and serve everything else normally

#### Scenario: remote shape needs no local runtime

- **WHEN** `BROWSER_CDP_ENDPOINT` points at a reachable browser and no local runtime exists
- **THEN** the lane SHALL compose against the endpoint and browser tools SHALL function

#### Scenario: explicit off wins over supply

- **WHEN** a deployment supplies a local runtime but sets `BROWSER_LANE=off`
- **THEN** the patch SHALL omit the lane

### Requirement: Each cell owns one shared browser state

Where the lane is local, browser state (tabs, cookies, login state) SHALL be shared
by every session of the owning cell or installation, because the MCP sidecar process
is shared per dsh runtime. Login state persisting across a user's sessions within one
cell SHALL be treated as intended behavior, while state SHALL NOT cross cells: two
users' cells SHALL hold independent browsers.

#### Scenario: login persists across sessions in one cell

- **WHEN** an agent in session A logs into a site and a later prompt in session B (same cell) revisits that site
- **THEN** the site SHALL present as logged in, without extra configuration

#### Scenario: no cross-cell leakage

- **WHEN** two hosted cells compose their lanes
- **THEN** each lane SHALL drive a separate browser process with separate profile state

### Requirement: Lane failures degrade explicitly

A lane that composed but whose browser fails to launch or attach SHALL surface the
upstream MCP connection failure through the MCP client's existing graceful-degradation
behavior (logged, server's other tools unaffected, no boot abort), and a failed remote
endpoint SHALL NOT silently redispatch to a local runtime.

#### Scenario: endpoint failure stays explicit

- **WHEN** `BROWSER_CDP_ENDPOINT` is set but the endpoint is unreachable
- **THEN** the lane SHALL report the MCP connection failure in logs
- **AND** no local launch SHALL be attempted as a fallback

### Requirement: Hosted-cell image carries the runtime and proves it

The hosted-cell image SHALL install a chromium runtime at build time and carry its
path in the lane's environment, and image smoke SHALL verify the lane can actually
launch and complete a navigation, not merely that the package is present.

#### Scenario: image smoke proves the lane

- **WHEN** image smoke runs against a built cell image
- **THEN** it SHALL launch the bundled chromium headlessly and complete a navigation
- **AND** a missing or broken runtime SHALL fail the smoke
