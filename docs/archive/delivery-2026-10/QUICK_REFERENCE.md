# Agent Cluster Platform - Quick Reference Card

## 🚀 Quick Start

### Create a Cluster via API
```bash
curl -X POST http://localhost:3000/api/clusters/dynamic \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Team",
    "description": "Custom team",
    "agents": [
      { "packId": "_abc123", "agentId": "finance-bot" },
      { "packId": "_def456", "agentId": "data-analyst" }
    ],
    "activateAll": true,
    "bindToSession": false
  }'
```

### Schedule Cluster Task
```javascript
// MCP tool call
cron_create({
  cron: "0 9 * * *",
  prompt: "Generate daily report",
  clusterId: "dyn_xyz789",
  executionPolicy: {
    allowParallel: true,
    resultAggregation: "summary"
  }
});
```

### View Clusters in UI
Navigate to: `http://your-domain/agents?tab=agents`

---

## 📋 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/clusters/dynamic` | Create cluster |
| GET | `/api/clusters/:id` | Get status |
| PATCH | `/api/clusters/:id` | Update metadata |
| DELETE | `/api/clusters/:id` | Terminate |
| POST | `/api/clusters/:id/agents` | Add agents |
| DELETE | `/api/clusters/:id/agents/:id` | Remove agent |
| GET | `/api/clusters/user/:email` | List user's clusters |

---

## 🔧 Common Operations

### Check Database
```bash
# Location
ls -la ./data/clusters.db

# Query clusters
sqlite3 ./data/clusters.db "SELECT * FROM dynamic_clusters ORDER BY last_used_at DESC LIMIT 10;"

# Count active clusters
sqlite3 ./data/clusters.db "SELECT COUNT(*) FROM dynamic_clusters WHERE status != 'terminated';"
```

### Monitor Logs
```bash
# Watch cluster logs
tail -f logs/server.log | grep "\[cluster\]"

# Search for errors
grep "cluster" logs/server.log | grep -i error
```

### Restart Server
```bash
pm2 restart all
# or
npm start
```

---

## ⚠️ Troubleshooting

### Issue: Cluster not created
**Symptoms:** API returns error when creating cluster

**Solutions:**
1. Check authentication: Ensure user is logged in
2. Verify pack subscriptions: All referenced packs must be installed
3. Check rate limit: Max 10 creations/hour per user
4. Validate request body: name required, agents array needed

### Issue: Cluster disappears
**Symptoms:** Cluster was created but no longer visible

**Causes:**
- Auto-termination after 24h idle with <5 executions
- Absolute timeout at 7 days
- Manual termination

**Solution:** Check logs for auto-termination messages

### Issue: Rate limiting too aggressive
**Symptoms:** "Too many cluster creations" error

**Solutions:**
1. Wait for rate limit window (1 hour)
2. Adjust limit in `.env`:
   ```bash
   CLUSTER_RATE_LIMIT=20
   ```
3. Restart server

### Issue: Database not created
**Symptoms:** Error about missing database

**Solutions:**
```bash
# Create data directory
mkdir -p ./data
chmod 755 ./data

# Database will be created on first cluster creation
```

### Issue: UI not showing clusters
**Symptoms:** Agents page doesn't display clusters

**Solutions:**
1. Clear browser cache
2. Rebuild frontend: `cd web && npm run build`
3. Check browser console for errors
4. Verify catalog includes cluster fields

---

## 📊 Monitoring Commands

### Check Cluster Status
```bash
# Active clusters
curl http://localhost:3000/api/clusters/user/your@email.com

# Specific cluster
curl http://localhost:3000/api/clusters/dyn_xyz789
```

### Database Health
```bash
# File size
du -h ./data/clusters.db

# Recent activity (last 24h)
sqlite3 ./data/clusters.db "SELECT COUNT(*) FROM dynamic_clusters WHERE last_used_at > datetime('now', '-1 day');"

# Candidates for cleanup
sqlite3 ./data/clusters.db "SELECT id, name, last_used_at FROM dynamic_clusters WHERE total_executions < 5 AND last_used_at < datetime('now', '-1 day');"
```

### API Health Check
```bash
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3000/api/clusters/dynamic \
  -X POST -H "Content-Type: application/json" \
  -d '{"name":"Health","description":"","agents":[],"activateAll":true}'
```

Expected: 400 (expected for invalid request)

---

## 🔑 Configuration

### Environment Variables
```bash
# Optional configuration
CLUSTER_DB_PATH=/custom/path/clusters.db
CLUSTER_RATE_LIMIT=20
CLUSTER_RATE_WINDOW_MS=3600000
```

### Default Values
- Database: `./data/clusters.db`
- Rate Limit: 10 clusters/hour/user
- Rate Window: 1 hour
- Auto-Termination Idle: 24 hours
- Auto-Termination Absolute: 7 days
- Min Executions for Keep: 5

---

## 📖 Useful Queries

### Find Inactive Clusters
```sql
SELECT id, name, last_used_at, total_executions 
FROM dynamic_clusters 
WHERE status != 'terminated'
AND total_executions < 5
AND last_used_at < datetime('now', '-24 hours')
ORDER BY last_used_at ASC;
```

### Cluster Usage Statistics
```sql
SELECT 
  COUNT(*) as total_clusters,
  SUM(CASE WHEN status != 'terminated' THEN 1 ELSE 0 END) as active_clusters,
  SUM(total_executions) as total_executions,
  SUM(total_tokens_used) as total_tokens
FROM dynamic_clusters;
```

### Top Used Clusters
```sql
SELECT id, name, total_executions, last_used_at
FROM dynamic_clusters
WHERE status != 'terminated'
ORDER BY total_executions DESC
LIMIT 10;
```

---

## 🎯 Best Practices

### For Users
1. **Name clusters meaningfully**: Use descriptive names
2. **Keep clusters active**: Run tasks regularly to avoid auto-termination
3. **Use appropriate agents**: Select only necessary agents
4. **Monitor usage**: Check cluster activity periodically

### For Administrators
1. **Monitor database size**: Clean up terminated clusters periodically
2. **Watch auto-termination**: Review candidates before deletion
3. **Adjust rate limits**: Based on actual usage patterns
4. **Backup database**: Regular backups of clusters.db

### For Developers
1. **Test locally**: Use test script before deployment
2. **Check logs**: Monitor for errors and warnings
3. **Document changes**: Update CHANGELOG for modifications
4. **Run tests**: Execute test suite before commits

---

## 🆘 Emergency Procedures

### Stop Auto-Termination (Temporary)
```bash
# Edit server/routes/clusters.js
# Comment out or modify the auto-termination job
# Restart server
```

### Force Delete Clusters
```bash
sqlite3 ./data/clusters.db "DELETE FROM dynamic_clusters WHERE status = 'terminated';"
```

### Reset Rate Limits
```bash
# Rate limiter resets automatically every hour
# No manual intervention needed
```

### Rollback Changes
```bash
git checkout lib/pack-manifest.js
git checkout catalog.js
git checkout server.js
# ... etc
npm start
```

---

## 📞 Support

- **Documentation**: See `docs/` directory
- **Tests**: `scripts/test-cluster-platform.mjs`
- **Deployment**: `scripts/deploy-cluster-platform.sh`
- **Monitoring**: `scripts/monitor-cluster-platform.sh`

---

*Quick Reference v1.0.0*  
*Last Updated: 2026-10-20*
