# Analysis: Satellite Sharing Fix (share-mcp-satellites-per-cell)

## Overview

This analysis documents the critical fix for "share-mcp-satellites-per-cell" implementation that addresses a drift issue between two predicates determining which MCP satellites should be shared across dsh workers in a cell.

## The Problem

### Two-Predicates Drift
The system had two separate mechanisms determining shareable satellites:

1. **Patch rewrite logic** in `dsh-profile.js` - determined which satellites should be converted to URL entries
2. **Host spawn logic** in `server/mcp-satellite-wiring.js` - determined what the satellite host should spawn

### Real Impact
This drift caused **duplicate satellite spawning**:
- Host spawned satellite A (converted to URL)
- Every dsh still spawned satellite A (keep stdio entry)
- Result: **worse than no sharing** (more satellites, not fewer)

### Example: bench-proposal Satellite
- Had `envRefs` (BENCH_URL, BENCH_CONSUMER_TOKEN, BENCH_PROPOSAL_DOMAIN)
- Considered "shareable" by patch rewrite (name in list, no explicit credentials)
- Rejected by host logic (has envRefs → not shareable)
- **Two copies running**: one per-cell host, one per-dsh

## Root Cause

### Patch Rewrite Logic (Original - BROKEN)
```javascript
// Before 1faa42008
for (const [name, config] of Object.entries(servers)) {
  if (!SHARED_SATELLITE_SERVERS.includes(name)) continue;
  if (config?.credentialEnv || config?.credentialRef || config?.credential) continue;
  if (Array.isArray(config?.envRefs) && config.envRefs.length) continue;
  servers[name] = { url: `${satelliteHostUrl}/${name}/mcp` }
}
```

### Host Logic (Original - BROKEN)
```javascript
// In satelliteSpecsFromPatch, read from patch
for (const row of inserts) {
  const name = row?.config?.serverName;
  if (!name || !SHARED_SATELLITE_SERVERS.includes(name)) continue;
  const command = row.config.command;
  if (!command) continue; // already a url entry — nothing to spawn
  specs.push({ ... });
}
```

**Both used hardcoded checks instead of a single predicate** → drift possible.

## The Fix (commit 1faa42008)

### 1. Extract Central Predicate
Created `isShareableSatellite()` in `dsh-profile.js`:
```javascript
export function isShareableSatellite(name, config) {
  if (!SHARED_SATELLITE_SERVERS.includes(name)) return false;
  if (config?.credentialEnv || config?.credentialRef || config?.credential) return false;
  if (Array.isArray(config?.envRefs) && config.envRefs.length) return false;
  return true;
}
```

**Key Design Decisions:**
- Takes both `name` and `config` parameters
- Single source of truth for ALL shareability decisions
- Exported so both patch rewrite AND host logic can use identical logic

### 2. Update Patch Rewrite
```javascript
// After fix
const sharedSatelliteNames = Object.entries(servers)
  .filter(([name, config]) => isShareableSatellite(name, config))
  without(mapped([name]))

for (const name of sharedSatelliteNames) {
  servers[name] = { url: `${satelliteHostUrl}/${name}/mcp` }
}
```

### 3. Add Authoritative List (`mcp.shared.json`)
```javascript
try {
  atomicWriteTextSync(
    join(dirname(patchPath), "mcp.shared.json"),
    JSON.stringify({ sharedSatelliteNames }, null, 2),
  );
} catch (err) {
  console.warn(`[dsh-profile] could not write mcp.shared.json: ${err?.message || err}`);
}
```

**Why mcp.shared.json?**
- Single source of truth, not re-derivable
- Persists across restarts
- Host reads FROM HERE, not from patch derivation
- Authoritative over derived logic

### 4. Update Host Logic
```javascript
// In satelliteSpecsFromPatch
try {
  const parsed = JSON.parse(readFileSync(join(dirname(patchPath), "mcp.shared.json"), "utf8"));
  if (Array.isArray(parsed?.sharedSatelliteNames)) authoritative = new Set(parsed.sharedSatelliteNames);
} catch {
  /* older profile dir — fall back to the declared list */
}

for (const row of inserts) {
  // ... same validation ...
  if (authoritative && !authoritative.has(name)) continue; // <-- KEY FIX
  // ... rest ...
}
```

## Files Modified

### Primary Changes (commit 1faa42008)

1. **`dsh-profile.js`**
   - Added `isShareableSatellite()` export
   - Updated patch rewrite to use central predicate
   - Added `mcp.shared.json` writing

2. **`server/mcp-satellite-wiring.js`**
   - Added imports for path utilities
   - Updated `satelliteSpecsFromPatch()` to read authoritative list
   - Added fallback for older profile directories

3. **`scripts/test-mcp-satellite-wiring.mjs`**
   - Added test "a satellite the rewrite refused is not spawned by the host"
   - Tests the central predicate consistency

## Real-World Impact

### Test Results (scratch A/B, 2026-11-09)

| Scenario | Before Fix | After Fix |
|----------|------------|-----------|
| **2 dsh** | 12 satellites (6 each) | **9 satellites (4.5 each)** |
| **Memory** | 909Mi RSS | **628Mi RSS** |
| **Savings** | - | **≈281Mi RAM** |

### Why This Works

1. **No Drift**: Single predicate prevents divergence
2. **Correct Sharing**: Only truly shareable satellites are shared
3. **Fail-open**: Missing mcp.shared.json falls back to declared list
4. **Backward Compatible**: Older profile dirs still work

## Design Principles Followed

### Single Source of Truth
- `mcp.shared.json` is authoritative, not derived
- Prevents re-derivation drift
- Persists across restarts and upgrades

### Centralized Logic
- `isShareableSatellite()` exported for reuse
- Two call sites MUST agree (enforced by design)
- Changes to sharing logic only requires one edit

### Conservative Migration
- Fallback for older profile directories
- Missing file = declared list (safe default)
- No breaking changes

## Testing and Verification

### Test Coverage
The test suite in `scripts/test-mcp-satellite-wiring.mjs` includes:

1. **Pool off**: No host, patch unchanged
2. **Explicit kill switch**: MCP_SATELLITE_HOST=0
3. **Shareable set detection**: Only fleet, cron (library, actions excluded)
4. **Central predicate verification**: "a satellite the rewrite refused is not spawned by the host" ← **KEY TEST**
5. **Empty shareable sets**: Declines cleanly
6. **Gray list rollout**: Per-cell sharing restrictions

### Manual Verification
Run the satellite sharing probe:
```bash
# Baseline (cap=0)
node scripts/probe-satellite-sharing.mjs

# After flipping TASK_WORKER_MAX  
node scripts/probe-satellite-sharing.mjs
```

Expected: Fewer satellites per dsh after fix.

## Critical Context

### Production Status
- **Current**: running on mirror `sha-6f121f5` (legacy image)
- **Platform**: `platform-5f47f47dbf`
- **Task Worker Max**: 0 (disables worker pool, prevents sharing)

### Future Integration
- **Real deployment**: When `TASK_WORKER_MAX>0` enabled
- **Worker pool**: 2 workers → 3 dsh total
- **Savings**: 16 satellites (≈1034Mi) when pool enabled

### Member-Scoped Protection
- **fd-memory**: member token in headers → NOT shareable
- **library**: LIBRARY_COLLECTIONS per member → NOT shareable  
- **websearch**: user key per session → NOT shareable
- **actions**: DSH_SESSION_ID per session → NOT shareable

## Technical Debt Resolution

This fix resolves the "2026-11-09 A/B defect" mentioned in the commit:
> "the host came to own satellites that every dsh also spawns: an envRefs-bearing satellite keeps its stdio entry in the patch, so 'still has a command' and 'was converted' are different sets."

**Solution**: Authority moves from DERIVATION to PERSISTED file.

## Next Steps

1. **Enable worker pool** (change `TASK_WORKER_MAX` from 0 to >0)
2. **Monitor real deployment** for 8-shareable-satellite targeting
3. **Verify member isolation** in production
4. **Document operational procedures** for rollout

## Conclusion

The fix is **minimal, focused, and follows established patterns**:
- Extract central predicate ✅
- Add authoritative persisted state ✅  
- Update all consumers to use single source ✅
- Maintain backward compatibility ✅

This resolves the drift issue and enables the intended satellite sharing benefits without regression.