## MODIFIED Requirements

### Requirement: A single command runs the E2E suite
The project SHALL provide an `npm run test:e2e` script that runs the offline deterministic Playwright `fast` project, an `npm run test:e2e:smoke` script that runs ONLY the `@smoke`-tagged chat-turn project (real LLM calls, requires local secrets), and `test:e2e:live`/`test:e2e:live:smoke` scripts for the remote live service. No script other than the explicit `live` scripts SHALL select the `live` Playwright project. Browser binaries SHALL be installable via `npx playwright install chromium`.

#### Scenario: run the fast suite
- **WHEN** a developer runs `npm run test:e2e`
- **THEN** the deterministic, no-LLM tests SHALL run against a freshly launched server

#### Scenario: run the smoke subset only
- **WHEN** a developer runs `npm run test:e2e:smoke`
- **THEN** only the `@smoke`-tagged tests SHALL be selected
- **AND** the `live` project tests SHALL NOT run and no request SHALL be made to the remote live service

#### Scenario: live suite stays opt-in
- **WHEN** a developer runs `npm run test:e2e` or `npm run test:e2e:smoke` without `PW_LIVE=1`
- **THEN** no test SHALL contact the deployed live service URL
