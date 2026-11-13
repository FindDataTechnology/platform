# pack-marketplace 变更 Delta

## ADDED Requirements

### Requirement: The deploy form offers deploy-time model and budget choices

The pack detail dialog's deploy-as-a-service section SHALL offer, for each serving-contract agent, a model input and a turn-budget input alongside the existing rhythm override — the deployer composes the deployment's initial service configuration (openspec: a2a-agent-serving, deploy requirements; agent-service-config) in one place instead of deploying first and editing on the serving config surface afterwards. Empty inputs SHALL mean "change nothing on this dimension": a deploy request omits the agent from its model and budget maps entirely, and the deployment's effective values then follow the standing precedence — an existing override preserved from the prior deployment when redeploying (openspec: agent-service-config, upgrade overlay semantics), else the manifest's declaration, else the platform default — byte-identical to the behavior before this form existed. There is no clear-back semantics at deploy time: the form never sends a null (clearing an existing override is the serving config surface's act, not the deploy form's). A filled model input SHALL ride the deploy request as the agent's deploy-time model choice, passing the same write-time validation gates (declared whitelist, billing lanes, runner roster) the deploy action already enforces; a filled budget input SHALL ride as the agent's per-turn budget override under the platform's budget rule (positive whole minutes within the platform cap).

The form SHALL validate the budget input client-side under the platform's budget rule and refuse to submit while it is invalid, naming the rule — a server round-trip must not be the first place a typo meets its error. Model inputs SHALL NOT be client-side lane-validated (lanes are a property of the bound billing key, unknowable in the form before deployment); a declared `modelWhitelist` in the serving contract SHALL surface as autocomplete options with the whitelist named in a hint, and the absence of a whitelist SHALL surface a hint that the choice is validated against the billing key's lanes at submit. A declared serving model or budget ceiling SHALL be visible as the input's placeholder so the deployer sees what an empty input yields. Deploy failures from the model gates SHALL surface as a localized guidance message, never raw transport English.

#### Scenario: The form renders model and budget inputs per serving agent

- **WHEN** the deploy section renders for a pack with a serving-contract agent
- **THEN** the agent's row offers a model input and a turn-budget input next to its rhythm override, each with a plain-language label

#### Scenario: Empty inputs ride no maps and change nothing

- **WHEN** the deployer submits with the model and budget inputs empty — on a first deploy or a redeploy of a pack whose deployment already carries overrides
- **THEN** the deploy request carries no model or budget maps for the agent, and the effective values follow the standing precedence (preserved override when one exists, else the declaration, else the platform default) exactly as before this form existed

#### Scenario: A filled model rides the deploy request and the gate error is localized

- **WHEN** the deployer fills a model and submits, and the choice is refused by a model gate (whitelist, billing lanes, or runner roster)
- **THEN** the deploy section surfaces a localized message naming the refusal, and no deployment is created

#### Scenario: The declared whitelist narrows and explains the input

- **WHEN** the serving contract declares a `modelWhitelist`
- **THEN** the model input offers the whitelist's entries as autocomplete options and names them in its hint

#### Scenario: An invalid budget never leaves the form

- **WHEN** the budget input holds a value that is not a positive whole number of minutes within the platform cap
- **THEN** the deploy button's submission is refused in the form with a message naming the rule, and no deploy request is sent

#### Scenario: The declared default is visible without filling anything

- **WHEN** the serving contract declares a model (or a budget ceiling) and the deploy section renders
- **THEN** the corresponding input's placeholder shows the declared value, so an empty input's effect is visible before submit

## MODIFIED Requirements

### Requirement: The deploy section explains itself in plain language

The pack detail dialog's deploy-as-a-service section SHALL open with a plain-language summary stating what deploying yields (the pack's agents go live as a conversation service: a shareable public chat page, per-round metering, deployer revenue share), and each of its subsections SHALL carry a one-line plain-language subtitle — the metering-key area (whose quota pays for visitor rounds), the rhythm area (whether the platform wakes the agent to act on its own schedule; no entries means it only answers when addressed), the model area (which model the agent thinks with; empty keeps the standing setting — an existing override, else the pack's declared default), and the budget area (the longest a single round may run; empty keeps the standing setting — an existing override, else the declared ceiling or the platform default). The deploy button's outcome expectation (deploying produces a shareable conversation page) SHALL be stated at the button. These explanations are presentation-level: the section's data behavior, permissions, and deploy semantics are exactly as before (openspec: pack-marketplace, deploy requirements; the section stays fully previewable to signed-out visitors).

#### Scenario: the section summary names the outcome

- **WHEN** the deploy section renders
- **THEN** it opens with the plain-language summary of what deploying yields before any control

#### Scenario: subsections carry their subtitles

- **WHEN** the deploy section renders with its metering-key, rhythm, model, and budget areas
- **THEN** each area carries its one-line plain-language subtitle

#### Scenario: the deploy button states its result

- **WHEN** the deploy section renders its deploy button
- **THEN** the expected outcome (a shareable conversation page) is stated adjacent to the button
