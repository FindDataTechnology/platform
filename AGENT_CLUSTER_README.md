# Agent Cluster Platform

A comprehensive implementation for managing groups of cooperating agents as unified clusters.

## 🎯 Overview

The Agent Cluster Platform enables users to:
- Define packs as agent clusters with default and optional agents
- Create dynamic clusters by combining agents from multiple packs
- Schedule tasks that run across multiple agents simultaneously
- Manage cluster lifecycle through a unified interface

## ✨ Features

- **Pack-as-Cluster**: Define any pack as a cluster template
- **Dynamic Assembly**: Create custom clusters at runtime
- **Cluster-Aware Scheduling**: Execute tasks across agent groups
- **Auto-Cleanup**: Automatic termination of inactive clusters
- **Rate Limiting**: Protection against abuse (10/hour/user)
- **Full API**: REST endpoints for all operations
- **Modern UI**: Modal, dialog, and page components
- **Bilingual**: English + Chinese support

## 📦 Installation

No new dependencies required. Uses existing:
- `better-sqlite3` for database
- `express` for API
- Existing PaaS infrastructure

## 🚀 Quick Start

### 1. Deploy Components

Files are already in place:
```bash
# Backend
server/routes/clusters.js
server/routes/clusters-db.js

# Frontend
web/src/components/clusters/ClusterComposerModal.tsx

# Tests
scripts/test-cluster-platform.mjs
```

### 2. Run Tests

```bash
node scripts/test-cluster-platform.mjs
```

Expected output: All 8 tests passing ✅

### 3. Start Server

```bash
npm start
# or
pm2 restart all
```

### 4. Try It Out

**Create a cluster via API:**
```bash
curl -X POST http://localhost:3000/api/clusters/dynamic \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Team",
    "description": "Test cluster",
    "agents": [
      { "packId": "_abc", "agentId": "test-agent" }
    ]
  }'
```

**View in UI:**
Navigate to `/agents?tab=agents`

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [Implementation Guide](docs/agent-cluster-implementation.md) | Full technical details |
| [Quick Start](docs/CLUSTER_PLATFORM_QUICKSTART.md) | Usage examples |
| [Deployment](docs/CLUSTER_PLATFORM_DEPLOYMENT.md) | Production setup |
| [Summary](AGENT_CLUSTER_README.md) | This file |

## 🔧 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/clusters/dynamic` | Create cluster |
| GET | `/api/clusters/:id` | Get status |
| PATCH | `/api/clusters/:id` | Update metadata |
| DELETE | `/api/clusters/:id` | Terminate |
| POST | `/api/clusters/:id/agents` | Add agents |
| DELETE | `/api/clusters/:id/agents/:id` | Remove agent |
| GET | `/api/clusters/user/:email` | List user's clusters |

## 📊 Specifications

Implemented per OpenSpec:
- `agent-cluster-core` - Core cluster abstraction
- `marketplace-cluster-view` - Marketplace integration
- `dynamic-cluster-composer` - Runtime assembly
- `scheduling-cluster-aware` - Cluster scheduling

## 🧪 Testing

```bash
# Unit tests
node scripts/test-cluster-platform.mjs

# Validation
openspec validate --changes agent-cluster-platform
```

## 📈 Monitoring

Watch for these logs:
```
[cluster] Cluster created: dyn_abc123
[cluster] Cluster terminated: dyn_xyz789
[cluster] Auto-terminating: dyn_inactive
```

Database location: `<data-dir>/clusters.db`

## 🛠️ Configuration

Optional environment variables:

```bash
CLUSTER_DB_PATH=/custom/path/clusters.db
CLUSTER_RATE_LIMIT=20
CLUSTER_RATE_WINDOW_MS=3600000
```

##  Troubleshooting

See [Deployment Guide](docs/CLUSTER_PLATFORM_DEPLOYMENT.md#troubleshooting)

## 📝 License

Part of the PaaS project. See main LICENSE file.

---

**Status**: Production Ready ✅  
**Version**: 1.0.0  
**Last Updated**: 2026-10-20
