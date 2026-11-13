## Why

LiteLLM fails to start when `DATABASE_URL` or `LITELLM_MASTER_KEY` environment variables are missing, showing a blocking error that prevents the proxy from initializing. This occurs because the bundled LiteLLM uses an embedded Postgres database (Prisma) for storing models, credentials, and configuration - but these sensitive values aren't being properly seeded in `.env`.

## What Changes

- Generate `LITELLM_MASTER_KEY` automatically on first run if not set
- Seed `LITELLM_SALT_KEY` with a random key if not present (with warning about immutability)
- Provide clear instructions in `.env` comments about what each variable does
- Add validation at startup to check required variables exist
- Gracefully degrade to non-DB mode if variables are unset (models stored in-memory only)
- Add e2e test covering LiteLLM startup without these variables

## Capabilities

### New Capabilities
- **litellm-config**: Self-contained LiteLLM initialization with auto-generated secrets

### Modified Capabilities
- No spec-level requirement changes

## Impact

- `scripts/start.js` - supervisor wrapper for LiteLLM
- `.env` - template comments and default behavior
- `supervisor/descriptors.js` - LiteLLM descriptor configuration
- `litellm.yaml` - Prisma configuration for embedded Postgres
