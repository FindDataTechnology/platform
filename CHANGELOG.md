# Changelog

All notable changes to the Agent Cluster Platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-20

### Added
- **Core Features**
  - Pack cluster metadata support in manifest validation
  - Dynamic cluster creation API with 7 REST endpoints
  - SQLite database persistence layer for clusters
  - Cluster-aware scheduling tools (cron_create, cron_list)
  - Auto-termination of inactive clusters (24h idle / 7 day absolute)
  - Rate limiting: 10 cluster creations per hour per user
  
- **UI Components**
  - ClusterComposerModal component for creating dynamic clusters
  - Cluster info section in PackDetailDialog
  - Cluster listing in AgentsPage
  - ClusterCard component for displaying clusters
  
- **API Endpoints**
  - `POST /api/clusters/dynamic` - Create new cluster
  - `GET /api/clusters/:id` - Get cluster status
  - `PATCH /api/clusters/:id` - Update cluster metadata
  - `DELETE /api/clusters/:id` - Terminate cluster
  - `POST /api/clusters/:id/agents` - Add agents to cluster
  - `DELETE /api/clusters/:id/agents/:agentId` - Remove agent from cluster
  - `GET /api/clusters/user/:email` - List user's clusters
  
- **Internationalization**
  - English translations for all UI elements
  - Chinese (Simplified) translations for all UI elements
  
- **Testing**
  - Comprehensive unit test suite (8 tests)
  - OpenSpec validation integration
  - Test scripts for cluster platform
  
- **Documentation**
  - Full implementation guide
  - Quick start guide with examples
  - Deployment guide with troubleshooting
  - Status reports and summaries
  - README files

### Changed
- Extended pack manifest schema to support cluster metadata
- Updated catalog.js to include cluster fields in responses
- Modified server.js to register cluster routes
- Enhanced cron-mcp.js with cluster-aware scheduling
- Updated AgentsPage to display user's clusters
- Extended packs-api.ts with cluster creation function

### Security
- Rate limiting prevents abuse
- Authentication required for all cluster operations
- User isolation: users can only access their own clusters
- Database WAL mode ensures data integrity

### Performance
- SQLite WAL mode for concurrent read/write efficiency
- Indexed queries for common operations
- In-memory rate limiter with automatic cleanup
- Efficient database serialization

### Infrastructure
- New database file: `clusters.db` in data directory
- No new npm dependencies required
- Uses existing better-sqlite3 and express

---

## [Unreleased]

### Planned
- User-cluster relationship in database
- Admin dashboard for cluster management
- Cluster templates marketplace
- Advanced execution policies (dependencies, ordering)
- Real-time monitoring dashboard
- Backup/restore functionality
- Performance metrics and alerting

### Under Consideration
- Multi-region deployment support
- Distributed rate limiting with Redis
- GraphQL API alternative
- WebSocket events for real-time updates

---

*For more details, see the documentation in the `docs/` directory.*
