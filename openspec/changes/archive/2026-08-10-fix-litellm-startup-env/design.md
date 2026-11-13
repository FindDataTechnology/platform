## Context

The Platform bundles LiteLLM as a local service for LLM proxy/gateway functionality. LiteLLM uses an embedded Postgres database (via Prisma) to persist models, credentials, and configuration. Currently, the startup process assumes these environment variables are manually configured, but they're not being auto-generated, causing LiteLLM to fail on first run with "Missing Environment Variables" error.

The supervisor (`scripts/start.js`) launches LiteLLM via the bundled Python venv, and `supervisor/descriptors.js` defines the LiteLLM service descriptor with environment variables. The `.env` file has placeholder comments but no auto-generation logic.

## Goals / Non-Goals

**Goals:**
- Auto-generate `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` on first run if missing
- Validate required environment variables before starting LiteLLM
- Provide clear error messages if configuration is incomplete
- Add e2e test to catch this regression
- Maintain backward compatibility with existing `.env` configurations

**Non-Goals:**
- Migrating existing users' configurations
- Supporting remote LiteLLM instances (already works via `LITELLM_BASE_URL`)
- Changing the embedded Postgres setup

## Decisions

### 1. Auto-generation location: `scripts/start.js`

**Decision:** Generate missing secrets in `scripts/start.js` before launching LiteLLM.

**Rationale:** This is the single entry point for the full stack. It already handles other first-run setup (like generating `litellm.yaml`). Centralizing secret generation here keeps the logic in one place and ensures it runs before any service starts.

**Alternative considered:** Generate in `supervisor/descriptors.js` — rejected because descriptors are meant to be declarative, not perform side effects.

### 2. Secret format: `sk-` prefix + 32 random hex chars

**Decision:** Use format `sk-<32 hex chars>` (e.g., `sk-a1b2c3d4e5f6...`).

**Rationale:** Matches common API key conventions (Stripe, OpenAI). The `sk-` prefix makes it obvious this is a secret key. 32 hex chars = 128 bits of entropy, sufficient for local dev.

**Alternative considered:** UUID v4 — rejected because it's less recognizable as an API key.

### 3. Persistence: Write to `.env` on first run

**Decision:** Write generated secrets to `.env` so they persist across restarts.

**Rationale:** Users need stable keys for API calls. If we regenerated on every restart, existing API clients would break. Writing to `.env` also makes the keys visible for manual inspection.

**Alternative considered:** Store in `dev-settings.json` — rejected because `.env` is the standard location and already gitignored.

### 4. Validation: Check before launching LiteLLM

**Decision:** Add validation in `scripts/start.js` after loading `.env`, before starting services.

**Rationale:** Fail fast with a clear error message rather than letting LiteLLM crash with a cryptic Prisma error. This also allows us to auto-generate missing values before validation.

**Alternative considered:** Let LiteLLM handle validation — rejected because the error message is unclear and we want to auto-generate.

### 5. E2E test: Verify LiteLLM starts without pre-configured secrets

**Decision:** Add e2e test that starts the full stack with a clean `.env` (no LiteLLM secrets) and verifies LiteLLM becomes healthy.

**Rationale:** This is the exact scenario that's currently broken. The test should fail on the old code and pass on the new code.

**Alternative considered:** Unit test the secret generation — rejected because the integration is the critical path.

## Risks / Trade-offs

**[Risk] User manually edits `.env` and breaks format** → Mitigation: Validate format on load, regenerate if invalid.

**[Risk] Generated secrets are too weak** → Mitigation: Use 32 hex chars (128 bits), which is standard for API keys. Document that production deployments should use stronger keys.

**[Risk] Writing to `.env` fails (permissions, read-only filesystem)** → Mitigation: Catch write errors, log warning, continue with in-memory secrets (they'll be regenerated on next restart, which is acceptable for dev).

**[Risk] Existing users have partial config (e.g., `LITELLM_MASTER_KEY` set but not `LITELLM_SALT_KEY`)** → Mitigation: Generate only missing values, don't overwrite existing ones.

**[Trade-off] Auto-generation vs explicit configuration** → We prioritize ease of setup (auto-generate) over explicit control. Users can still manually set values in `.env` if they want specific keys.
