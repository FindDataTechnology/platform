# bot-relay Specification (delta)

## ADDED Requirements

### Requirement: Deployed agent services notify through the same relay path

Notifications originating from deployed Agent Services SHALL enter through the existing relay endpoint, the existing machine-token authentication, and the existing named-channel addressing: a deployment binds one administrator-pre-bound channel name, the runner presents the relay token server-to-server, and every guarantee of the relay — per-channel rate limits, text-length bounds, admin-managed bindings only, send records without message content — SHALL apply to agent-originated sends identically. Introducing agent notifications SHALL NOT add a second outbound path, a second token owner, or any destination type the relay does not already serve.

#### Scenario: An agent notification rides the existing endpoint

- **WHEN** the runner forwards a deployed agent's notification to the relay
- **THEN** it is authenticated, addressed, bounded, and recorded exactly like any other relay send, and delivery uses the single outbound send path

#### Scenario: Agent sends cannot widen addressing

- **WHEN** a forwarded notification names a channel, bot, or chat key beyond the deployment's bound channel
- **THEN** the relay's existing destination rules apply unchanged — extra destination fields have no effect, and unknown channels are refused
