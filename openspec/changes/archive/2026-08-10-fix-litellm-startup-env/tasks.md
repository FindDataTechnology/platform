## Tasks

### 1. Generate LiteLLM secrets on first run
- [x] Add `generateLitellmSecrets()` function to `scripts/start.js`
- [x] Generate `LITELLM_MASTER_KEY` if not set (random 32-byte hex)
- [x] Generate `LITELLM_SALT_KEY` if not set (random 32-byte hex)
- [x] Log warning when generating keys (especially SALT_KEY immutability)
- [x] Inject generated keys into environment before spawning LiteLLM

### 2. Update .env template with clear documentation
- [x] Add comments explaining each LiteLLM variable
- [x] Document that SALT_KEY cannot be changed once set
- [x] Document that MASTER_KEY is required for API access
- [x] Add example values (not actual secrets)

### 3. Add startup validation
- [x] Check for required variables in `supervisor/descriptors.js`
- [x] Log clear error message if DATABASE_URL is missing
- [x] Provide fallback to in-memory mode if DB unavailable

### 4. Update LiteLLM descriptor
- [x] Pass generated secrets via environment
- [x] Ensure DATABASE_URL is properly constructed from embedded Postgres
- [x] Add health check retry logic (wait for Postgres to be ready)

### 5. Add e2e test
- [ ] Test LiteLLM startup without pre-set environment variables
- [ ] Verify secrets are auto-generated
- [ ] Verify LiteLLM responds to health checks
- [ ] Test embedded Postgres connection

### 6. Documentation
- [ ] Update README.md with LiteLLM configuration section
- [ ] Document how to manually set custom keys
- [ ] Document migration path for existing deployments
