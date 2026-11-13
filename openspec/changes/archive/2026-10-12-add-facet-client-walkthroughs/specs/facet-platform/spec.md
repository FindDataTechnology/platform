## ADDED Requirements

### Requirement: Client walkthroughs are verified against real environments

The five supported client targets SHALL each carry a walkthrough record in its deep guide (docs/ecosystem/) verified against a real environment: a real console-minted caller key through `connect`, a real `install --write-mcp` landing skills in the target's directory and the native MCP config in the target's shape (byte-verified), and a wire-level `initialize` probe succeeding with that key and endpoint. Guides SHALL state the honest boundaries discovered by the walkthrough — a pack's MCP references reflect its manifest (connectivity further requires the server healthy and visible to the key's groups), the CLI device flow requires an IdP-registered client (unregistered today: paste-key is the working path), and probes must carry both Accept types.

#### Scenario: A reader trusts the guide's path

- **WHEN** a reader follows a client guide's install and connect steps
- **THEN** the documented skill paths and MCP config shapes match what the CLI actually writes, because each was byte-verified in a recorded walkthrough

#### Scenario: Boundaries are stated, not hidden

- **WHEN** a pack's MCP reference points at a server that is disabled or invisible to the caller's groups
- **THEN** the guide explains the resulting 405/401 honestly instead of implying misconfiguration of the client
