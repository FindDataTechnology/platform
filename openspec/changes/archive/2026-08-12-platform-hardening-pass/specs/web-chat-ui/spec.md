## MODIFIED Requirements

### Requirement: Chat UI handles WebSocket connection lifecycle
The chat UI SHALL connect to the WebSocket server on page load, display connection status, and reconnect on disconnect using exponential backoff. The reconnect delay SHALL be `min(30000, 1000 * 2^attempt)` milliseconds multiplied by ±25% jitter. The UI SHALL stop scheduling reconnect attempts after a maximum of 20 attempts. The attempt counter SHALL reset to 0 on a successful connection (`onopen`). The UI SHALL listen for the browser `online` event and, when the network is restored, clear any pending reconnect timer, reset the attempt counter, and reconnect immediately — bypassing the backoff. The unmount guard (`cancelled`) SHALL be preserved so a cleaned-up component does not reconnect or schedule further timers.

#### Scenario: connection lost triggers backoff
- **WHEN** the WebSocket connection drops and the component is still mounted
- **THEN** the UI SHALL show a "Disconnected" status
- **AND** SHALL schedule a reconnect after a jittered exponential delay (`min(30000, 1000 * 2^attempt)` × ±25%)

#### Scenario: backoff stops after the cap
- **WHEN** the connection has failed the maximum number of reconnect attempts (20)
- **THEN** the UI SHALL stop scheduling further reconnect attempts

#### Scenario: online event triggers immediate reconnect
- **WHEN** the browser fires the `online` event while disconnected and a reconnect timer may be pending
- **THEN** the UI SHALL clear the pending timer, reset the attempt counter to 0, and reconnect immediately

#### Scenario: successful connection resets the counter
- **WHEN** a reconnect attempt succeeds (`onopen`)
- **THEN** the attempt counter SHALL reset to 0

#### Scenario: unmount stops reconnection
- **WHEN** the component unmounts
- **THEN** the unmount guard SHALL prevent further reconnect attempts and clear any pending timer
