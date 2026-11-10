# Agent Cluster Platform - Quick Start Guide

## Overview

The Agent Cluster Platform enables users to:
1. **Define packs as agent clusters** with default and optional agents
2. **Create dynamic clusters** by combining agents from multiple packs
3. **Schedule cluster-aware tasks** that run across multiple agents
4. **Manage and operate** agent clusters through a unified interface

## Quick Examples

### 1. Define a Pack as a Cluster

Add cluster metadata to your pack manifest:

```json
{
  "name": "Finance Analyst Pack",
  "description": "Financial analysis agents",
  "tags": ["finance", "analysis"],
  "skills": [
    {
      "name": "financial-data-extraction",
      "description": "Extract financial data",
      "content": "# Financial Data Extraction\n..."
    }
  ],
  "agents": [
    {
      "id": "finance-bot",
      "name": "Finance Bot",
      "persona": "You are a finance bot specialized in..."
    },
    {
      "id": "data-analyst",
      "name": "Data Analyst",
      "persona": "You are a data analyst..."
    },
    {
      "id": "report-generator",
      "name": "Report Generator",
      "persona": "You generate reports..."
    }
  ],
  "cluster": {
    "name": "Finance Analyst Cluster",
    "description": "A team of agents for comprehensive financial analysis",
    "defaultAgents": ["finance-bot", "data-analyst"],
    "optionalAgents": ["report-generator"],
    "schedulingPolicy": {
      "maxConcurrentRuns": 3
    }
  }
}
```

### 2. Create a Dynamic Cluster via API

```bash
curl -X POST http://localhost:3000/api/clusters/dynamic \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Analysis Team",
    "description": "Custom team for daily reports",
    "agents": [
      { "packId": "_abc123", "agentId": "finance-bot" },
      { "packId": "_def456", "agentId": "data-analyst" }
    ],
    "activateAll": true,
    "bindToSession": false
  }'
```

Response:
```json
{
  "clusterId": "dyn_xyz789",
  "status": "ready",
  "name": "My Analysis Team",
  "agents": [
    { "packId": "_abc123", "agentId": "finance-bot", "status": "active" },
    { "packId": "_def456", "agentId": "data-analyst", "status": "active" }
  ]
}
```

### 3. Schedule a Cluster Task via MCP

In your agent conversation, use the `cron_create` tool:

```javascript
// MCP tool call
{
  "name": "cron_create",
  "arguments": {
    "cron": "0 9 * * *",
    "prompt": "Generate daily financial summary report",
    "tz": "Asia/Shanghai",
    "name": "Daily Finance Report",
    "clusterId": "dyn_xyz789",
    "executionPolicy": {
      "allowParallel": true,
      "resultAggregation": "summary"
    }
  }
}
```

This creates a task that runs every day at 9 AM, executing across all agents in the cluster concurrently.

### 4. View Your Clusters

Navigate to `/agents?tab=agents` to see:
- Your dynamic clusters (if any)
- All available expert agents from installed packs
- Custom presets you've created

Click on a cluster to manage it or view its details.

### 5. Manage Clusters via API

**Get cluster status:**
```bash
curl http://localhost:3000/api/clusters/dyn_xyz789
```

**Update cluster:**
```bash
curl -X PATCH http://localhost:3000/api/clusters/dyn_xyz789 \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Cluster Name"}'
```

**Terminate cluster:**
```bash
curl -X DELETE http://localhost:3000/api/clusters/dyn_xyz789
```

## UI Features

### Pack Detail Dialog
When viewing a pack with cluster metadata:
- **Cluster Info section** shows cluster name, description, and agent count
- **Agent Composition** lists default agents (marked) and optional agents (collapsible)
- Helps you understand what's included before subscribing

### Cluster Composer Modal
Click "Create Cluster" to:
1. Enter cluster name and description
2. Select agents from your installed packs
3. Choose activation policy (activate all on creation?)
4. Optionally bind to current session
5. Monitor creation progress

### Agents Page
View your dynamic clusters alongside:
- Expert agents grid (from catalog)
- Custom presets management
- Market tab for browsing packs

## Scheduling Tools Enhancement

The scheduling tools now support cluster context:

### cron_create
```javascript
// Single agent (existing behavior)
cron_create({
  cron: "0 9 * * *",
  prompt: "Generate report",
  tz: "Asia/Shanghai"
})

// Cluster task (NEW)
cron_create({
  cron: "0 9 * * *",
  prompt: "Generate report",
  clusterId: "dyn_xyz789",
  executionPolicy: {
    allowParallel: true,
    timeoutMinutes: 30,
    resultAggregation: "summary"
  },
  targetAgents: ["finance-bot"] // override which agents to run
})
```

### cron_list
Now shows cluster information:
```
- job_123 [active]: daily at 09:00 (Asia/Shanghai) — "Generate report" | last: ok [cluster: Finance Cluster, agents: 3]
- job_456 [active]: daily at 10:00 (Asia/Shanghai) — "Send notification" | last: ok
```

## Rate Limiting

- **10 cluster creations per hour per user**
- Prevents abuse while allowing normal usage
- Error message if limit exceeded

## Auto-Termination

Clusters are automatically terminated when:
- Idle for **24 hours** with **fewer than 5 executions**, OR
- Absolute timeout of **7 days** regardless of activity

Grace period: 1 hour warning before deletion

## Testing

Run the test suite:
```bash
node scripts/test-cluster-platform.mjs
```

Tests cover:
- Pack manifest validation
- Cluster metadata rules
- Edge cases (empty arrays, duplicates, invalid refs)

## Troubleshooting

### Cluster not showing up
1. Check if pack has cluster metadata in manifest
2. Verify pack is installed and agents materialized
3. Refresh catalog (`catalog_changed` event)

### Cluster creation fails
1. Check rate limit (10/hour)
2. Verify all referenced packs are installed
3. Check network connectivity to API

### Task not running on cluster
1. Verify cluster exists and is active
2. Check cluster hasn't been auto-terminated
3. Ensure execution policy is valid

## Next Steps

1. **Explore the UI**: Navigate to `/agents` and try creating a cluster
2. **Read the full spec**: Check `openspec/specs/` for detailed requirements
3. **Review implementation**: See `docs/agent-cluster-implementation.md`
4. **Contribute**: Submit packs with cluster metadata to the marketplace

---

*Quick Start Guide v0.1.0*  
*For questions, refer to the main documentation or open an issue.*
