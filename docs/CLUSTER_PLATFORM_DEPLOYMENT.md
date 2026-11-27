# Agent Cluster Platform - Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the Agent Cluster Platform feature in your environment.

## Prerequisites

- Node.js 18+ 
- SQLite (included with better-sqlite3)
- Existing PaaS deployment
- Access to modify server and web components

## Installation Steps

### 1. Dependencies Check

The implementation uses existing dependencies:
- `better-sqlite3` - Already included in your project
- Express.js - Already included
- No new npm packages required

Verify installation:
```bash
npm list better-sqlite3
npm list express
```

### 2. Database Setup

The cluster database will be automatically created at:
```
<path-to-data-dir>/clusters.db
```

Ensure the data directory is writable:
```bash
# Check if directory exists
ls -la <path-to-data-dir>/

# Create if needed
mkdir -p <path-to-data-dir>
chmod 755 <path-to-data-dir>
```

### 3. Configuration Options

No additional environment variables are required. The system works with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_DB_PATH` | `<data-dir>/clusters.db` | Custom database path |
| `CLUSTER_RATE_LIMIT` | 10 | Max clusters per hour per user |
| `CLUSTER_RATE_WINDOW_MS` | 3600000 | Rate limit window (1 hour) |

Optional configuration in `.env`:
```bash
# Custom database path
CLUSTER_DB_PATH=/custom/path/to/clusters.db

# Adjust rate limits if needed
CLUSTER_RATE_LIMIT=20
CLUSTER_RATE_WINDOW_MS=3600000
```

### 4. Deploy Components

#### Backend Changes
The following files have been modified/created:
- `server/routes/clusters.js` - New API endpoints
- `server/routes/clusters-db.js` - Database layer
- `server/cron-mcp.js` - Extended scheduling tools
- `server.js` - Route registration

#### Frontend Changes
- `web/src/components/clusters/ClusterComposerModal.tsx` - New component
- `web/src/pages/AgentsPage.tsx` - Updated with cluster listing
- `web/src/lib/packs-api.ts` - API client functions
- `web/src/locales/*/common.json` - Translations

#### Core Logic
- `lib/pack-manifest.js` - Cluster metadata validation
- `catalog.js` - Cluster fields in catalog response

### 5. Build Frontend

Rebuild the web application:
```bash
cd web
npm run build
# Or your preferred build command
```

### 6. Restart Server

Restart your server to load the new routes:
```bash
# Using PM2
pm2 restart all

# Or manually
node server.js
```

### 7. Verify Deployment

Test the deployment with these checks:

**Check 1: Database Created**
```bash
ls -la <path-to-data-dir>/clusters.db
```

**Check 2: API Endpoints Available**
```bash
curl http://localhost:3000/api/clusters/dynamic -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","agents":[],"description":"Test cluster"}'
```

Expected: 400 error (no agents provided) means endpoint is working

**Check 3: Catalog Includes Cluster Fields**
```bash
curl http://localhost:3000/api/catalog | jq '.agents[] | select(.clusterId)'
```

Expected: Returns agents with cluster metadata if any packs have it

**Check 4: UI Loads Correctly**
Navigate to:
```
http://localhost:3000/agents?tab=agents
```

Look for:
- "My Clusters" section (if you have clusters)
- Pack detail dialogs showing cluster info
- "Create Cluster" functionality

## Testing Checklist

### Functional Tests

- [ ] Create a pack with cluster metadata
- [ ] Subscribe to the pack
- [ ] View cluster info in pack detail dialog
- [ ] Create a dynamic cluster via UI
- [ ] Schedule a cluster task via MCP tools
- [ ] View cluster in Agents page
- [ ] Terminate a cluster
- [ ] Verify auto-termination after inactivity

### Performance Tests

- [ ] Create 10 clusters in rapid succession (should hit rate limit on 11th)
- [ ] Query cluster status under load
- [ ] Monitor database size growth

### Integration Tests

- [ ] Verify existing packs still work without cluster metadata
- [ ] Confirm catalog filtering still works correctly
- [ ] Test scheduling tools with and without cluster context

## Monitoring

### Logs to Watch

Server logs will show:
```
[cluster] Cluster created: dyn_abc123
[cluster] Cluster terminated: dyn_xyz789
[cluster] Auto-terminating cluster: dyn_inactive
```

Database WAL mode ensures good performance:
```sql
PRAGMA journal_mode;  -- Should return 'wal'
```

### Metrics to Track

- Cluster creation rate
- Active cluster count
- Auto-termination events
- Database size
- API response times

## Rollback Procedure

If issues occur, rollback is straightforward:

1. **Stop the server**
   ```bash
   pm2 stop all
   ```

2. **Remove new files**
   ```bash
   rm server/routes/clusters.js
   rm server/routes/clusters-db.js
   ```

3. **Revert modified files** (from git)
   ```bash
   git checkout lib/pack-manifest.js
   git checkout catalog.js
   git checkout server.js
   # ... etc
   ```

4. **Rebuild frontend**
   ```bash
   cd web && npm run build
   ```

5. **Restart server**
   ```bash
   pm2 start all
   ```

## Troubleshooting

### Issue: Database not created

**Symptoms:** Error about file permissions or missing database

**Solution:**
```bash
# Check directory permissions
ls -ld <path-to-data-dir>

# Fix permissions
chmod 755 <path-to-data-dir>

# Check SQLite is available
node -e "require('better-sqlite3'); console.log('OK')"
```

### Issue: API returns 404

**Symptoms:** `/api/clusters/*` endpoints not found

**Solution:**
1. Verify `server/routes/clusters.js` exists
2. Check `server.js` imports the route handler
3. Restart server
4. Check server logs for import errors

### Issue: Clusters not appearing in UI

**Symptoms:** Agents page doesn't show clusters

**Solution:**
1. Clear browser cache
2. Rebuild frontend: `cd web && npm run build`
3. Check browser console for errors
4. Verify catalog includes cluster fields

### Issue: Rate limiting too aggressive

**Symptoms:** Users can't create clusters frequently enough

**Solution:**
Adjust rate limit in `.env`:
```bash
CLUSTER_RATE_LIMIT=20  # Increase from default 10
```

Then restart server.

## Security Considerations

### Authentication
All cluster APIs require authentication. Ensure:
- User sessions are properly validated
- Rate limiting applies per authenticated user
- User can only access their own clusters

### Data Protection
- Database file should be protected (not world-readable)
- Backup database regularly
- Consider encrypting sensitive cluster metadata

### Rate Limiting
Default 10/hour/user prevents abuse while allowing normal usage. Monitor and adjust based on actual usage patterns.

## Performance Tips

### Database Optimization
- WAL mode is enabled by default (good for concurrent reads)
- Consider VACUUM periodically if database grows large
- Indexes are auto-created for common queries

### Memory Management
- Rate limiter uses in-memory Map (cleans up old entries)
- Consider moving to Redis for distributed deployments

### Caching
- Catalog responses include cluster fields
- Consider adding Redis caching for frequent queries

## Upgrade Path

Future upgrades will be backward compatible:
- New cluster fields are optional
- Existing packs without cluster metadata continue to work
- Database schema additions are additive only

To upgrade:
1. Pull new code
2. Run tests
3. Deploy during maintenance window
4. Monitor for issues

## Support

For issues or questions:
1. Check this documentation first
2. Review test suite for examples
3. Check OpenSpec specs for detailed requirements
4. Contact development team

---

*Deployment Guide v1.0.0*  
*Last Updated: 2026-10-20*
