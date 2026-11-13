## MODIFIED Requirements

### Requirement: The 壹座 Store tab carries a market guide entry

On the 壹座 pack market surface (`/packs` — the route the dissolved Agents-page Market tab became; the legacy `/agents?tab=market` deep link keeps resolving to the same facet line so old bookmarks are not left with a context-free dock), the copilot dock SHALL resolve the facet line's focused assistant (existing `GET /api/boards/facet/copilot` resolution, no new endpoint) and open the guide with that preset injected — same open/restore semantics as the board path. While the guide is open, the surface SHALL publish the currently inspected pack (from the detail dialog's lifecycle) into the guide's context bar via the existing same-origin postMessage channel; the injection SHALL be read-only (the embed registers no page-action handler, and any write intent SHALL still travel through the action gate's propose path). When the facet assistant pack is not installed (no resolvable focused preset), the surface SHALL surface an honest hint pointing at the assistant's market entry instead of an unfocused guide pretending to be gated. The facet standalone site (anonymous surface) carries no guide entry in this scope.

#### Scenario: opening the guide from the Market tab injects the focused preset

- **WHEN** a signed-in user on `/packs` opens the copilot dock and the 谦面助手 pack is installed
- **THEN** the guide session runs under the `facet-assistant` focused preset and the context bar names it

#### Scenario: the inspected pack reaches the guide's context

- **WHEN** the pack detail dialog is open and the user asks the guide a question
- **THEN** the guide's context bar shows the current pack and the answer may reference it

#### Scenario: write intent stays gated

- **WHEN** the user asks the guide to subscribe to the inspected pack
- **THEN** the turn surfaces an action proposal card (propose/confirm/audit), never a direct subscription

#### Scenario: honest degradation without the assistant pack

- **WHEN** the 谦面助手 pack is not installed on the cell
- **THEN** the Market tab shows the guidance hint toward the assistant's market entry and the guide does not claim a focused preset

#### Scenario: the standalone site carries no guide

- **WHEN** an anonymous visitor browses the facet standalone site
- **THEN** no guide entry appears (the anonymous-surface guide is out of scope)
