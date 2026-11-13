# PR: Add wanxing_agent_deploy tool to wanxing-ops-mcp

## Summary

Add a new MCP tool `wanxing_agent_deploy` that allows deploying an agent to either cloud or desktop target. This is required for the action gate integration (add-line-boards-and-action-gate).

## Changes

### New Tool

```python
@tool
async def wanxing_agent_deploy(
    pack_id: str,
    agent_id: str,
    target: str,  # "cloud" or "desktop:<seat_id>"
    billing_key_ref: str | None = None,  # required for cloud
    rhythm: str | None = None,
    budget_minutes: int | None = None,
) -> dict[str, Any]:
    """Deploy an agent from a pack to cloud or desktop."""
```

### Implementation Notes

- **Cloud target**: Requires `billing_key_ref` (sub2api sk- key). Calls facade `/api/wanxing/v1/console/my/packs/:id/deploy`.
- **Desktop target**: No billing key required. Deploys to local runner seat via registry reconciliation.
- Returns `{ deploymentId, status, message }`.

### Testing

- Unit tests for both targets
- Integration test with real facade (cloud) and local runner (desktop)
- Verify preflight checks in action-gate route

## Dependencies

- Existing wanxing facade deploy endpoint (`services/wanxing-facade/selfservice.js:402`)
- Existing desktop fleet registry reconciliation (`agent-runner/registry.js`)

## Related

- Paas change: `add-line-boards-and-action-gate`
- Action gate preflight: `lib/action-preflight.js` handles `wanxing.agent.deploy`
