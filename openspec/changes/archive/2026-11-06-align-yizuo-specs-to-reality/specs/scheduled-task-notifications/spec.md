## MODIFIED Requirements

### Requirement: WeChat subscribe-message envelope is best-effort
The WeChat subscribe-message envelope is a planned increment, not an implemented capability: neither the miniprogram nor the server side carries any `requestSubscribeMessage` code today, so no subscribe message is sent and completed jobs surface through in-app unread only. When the envelope is implemented, it SHALL keep the best-effort contract below: the system MAY deliver a WeChat subscribe message for a completed job when the user has an unused message consent for that template; when consent is absent or exhausted, delivery SHALL silently degrade to in-app unread only, leaving job execution and history unaffected. Consent SHALL, at implementation time, be requested only from explicit user interaction (task creation flow or an in-app notice setting), never opportunistically.

#### Scenario: Consent available
- **WHEN** a job completes and the user holds an unused consent for the notification template
- **THEN** a subscribe message summarizing the job and linking to its session is sent

#### Scenario: Consent exhausted
- **WHEN** a job completes and no unused consent remains
- **THEN** no message is sent and no error surfaces to the user
- **AND** the session's unread state is unaffected

#### Scenario: Consent requested only on interaction
- **WHEN** the user creates a task in the miniprogram
- **THEN** the app MAY offer the notification-consent dialog as part of that flow
- **AND** the system SHALL NOT request consent outside explicit user interaction
