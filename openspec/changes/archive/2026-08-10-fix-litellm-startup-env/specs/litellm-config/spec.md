## ADDED Requirements

### Requirement: Auto-generate LiteLLM secrets on first run
The system SHALL automatically generate `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` if they are not present in `.env` on first startup. Generated values MUST be cryptographically random and persisted to `.env` for subsequent runs.

#### Scenario: First run without secrets
- **WHEN** user runs `npm start` and `.env` does not contain `LITELLM_MASTER_KEY` or `LITELLM_SALT_KEY`
- **THEN** system generates random values for both keys and writes them to `.env`
- **THEN** LiteLLM starts successfully with the generated secrets

#### Scenario: Subsequent runs with existing secrets
- **WHEN** user runs `npm start` and `.env` already contains `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY`
- **THEN** system uses existing values without modification
- **THEN** LiteLLM starts successfully with the existing secrets

### Requirement: Warn about LITELLM_SALT_KEY immutability
The system SHALL display a clear warning when generating `LITELLM_SALT_KEY` for the first time, explaining that changing it later will prevent access to encrypted data in the database.

#### Scenario: First-time generation warning
- **WHEN** system generates `LITELLM_SALT_KEY` for the first time
- **THEN** console output includes warning: "LITELLM_SALT_KEY generated. DO NOT CHANGE - changing this value will prevent access to encrypted data in the database"

### Requirement: Validate required environment variables at startup
The system SHALL validate that all required LiteLLM environment variables are present before starting the LiteLLM process. If validation fails, the system SHALL display a clear error message and prevent LiteLLM from starting.

#### Scenario: Missing DATABASE_URL
- **WHEN** `DATABASE_URL` is not set and embedded Postgres is not available
- **THEN** system displays error: "DATABASE_URL is required for LiteLLM database storage"
- **THEN** LiteLLM process is not started

#### Scenario: All required variables present
- **WHEN** all required variables (`DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`) are present
- **THEN** LiteLLM process starts successfully

### Requirement: Document environment variables in .env template
The system SHALL include clear comments in `.env` explaining what each LiteLLM variable does, whether it's required, and what happens if it's missing.

#### Scenario: User reads .env comments
- **WHEN** user opens `.env` file
- **THEN** comments explain that `LITELLM_MASTER_KEY` is the master API key for the proxy
- **THEN** comments explain that `LITELLM_SALT_KEY` is used for encrypting credentials and cannot be changed
- **THEN** comments explain that `DATABASE_URL` points to the Postgres database for model storage

### Requirement: E2E test for LiteLLM startup
The system SHALL include an e2e test that verifies LiteLLM starts successfully even when environment variables are not pre-configured.

#### Scenario: Clean startup test
- **WHEN** e2e test runs with a fresh `.env` (no LiteLLM variables set)
- **THEN** system auto-generates required secrets
- **THEN** LiteLLM process starts and responds to health checks
- **THEN** test passes
