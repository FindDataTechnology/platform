# Changelog

All notable changes to the Agent Cluster Platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.29] - 2026-11-28

桌面端发布链路的整轮修复，以及 Linux 客户端首次发布。

### Added
- **Linux 桌面客户端（AppImage x64）**：免 root、单文件、原子自更新。以 AppImage 形态运行时
  自动查新/差分下载/退出时替换自身；解包运行（无 FUSE 2）时如实降级为「仅提示」，不谎报已安装。
- **移动端 Android 分发**：签名 APK 发布到官网下载域 + 版本清单（`app-releases.json`），
  App 内「检查更新」读同一份清单，不需要任何应用商店账号。
- 官网下载页新增 Linux 与 Android 条目；iOS 如实说明需付费开发者账号。

### Changed
- **更新发布道迁移到公网 HTTPS**（`platform.finddatatech.cloud/dl/platform/lane/`）。此前默认通道是
  内网地址，从官网安装的用户查新必然失败——这是「装了升不了级」的根因。内网地址降为可选兜底
  （设置面可配，两条更新路径都会回退）。
- **签名事实随产物走**：`build-flags.json` + macOS `codesign` 校验，取代一个从未被设置的
  环境变量（它导致 macOS 即使签名也永远只提示不安装）。
- **更新目标按平台+架构选择**：Intel Mac 不再被引导下载 arm64 包；跨平台清单混入也不会
  把 AppImage 发给 mac 客户端。
- 差量升级：发布 blockmap 并在元数据里写 `blockMapSize`。

### Fixed
- **发布道正在广播预发布版本**（`1.3.29-test`，持续三周）——已清除，收敛到最后一个正式产物。
- **发布门**：预发布标记或版本不递增时发布硬失败，`release-sync` 拒写。
- **三向对账**（公网道 / 发布标记 / 内网兜底）：任一侧预发布即红、兜底落后即红；此前的
  两向对账在「两边同坏」时报 OK。
- 官网站点镜像构建因匿名 GitHub API 配额打满而中止（48/73 仓 403）——改为使用 job 自带的 token。

### Known limitations
- Linux 常驻管家（steward）明确不支持：AppImage 每次挂载到临时目录，注册自启单元必然失效。
- macOS / Windows 安装包仍未签名（无代码签名证书）。
- 移动端 iOS 无公开分发；OTA 未做。

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
