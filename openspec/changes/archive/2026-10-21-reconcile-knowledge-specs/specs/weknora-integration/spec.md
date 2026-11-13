## REMOVED Requirements

### Requirement: WeKnora is bundled as a sidecar service
**Reason**: 代码 2026-08-04 落地当天即被移除（commit `ef60adcf` "Removed WeKnora integration (replaced with local PageIndex)"），此后无任何实现在产；spec 成死信两个半月。
**Migration**: 无（无用户数据经过该路径；重摄取语义当时已声明）。

### Requirement: Redis is bundled as a sidecar service
**Reason**: 同上——WeKnora 整链移除时一并删除；且当日在实施的 tasks 里已改判为远程实例方案，本需求从未与出货行为一致。

### Requirement: WeKnora connects to the existing embedded PostgreSQL
**Reason**: 同上，随 WeKnora 整链移除。

### Requirement: WeKnora credentials are auto-provisioned
**Reason**: 同上，随 WeKnora 整链移除。

### Requirement: WeKnora's LLM is configured to use Volces
**Reason**: 同上，随 WeKnora 整链移除。

### Requirement: WeKnora's REST API is proxied with token injection
**Reason**: 同上，随 WeKnora 整链移除。

### Requirement: WeKnora's web UI is reverse-proxied at /weknora-web
**Reason**: 同上，随 WeKnora 整链移除；`/weknora-web` 路由不存在。

### Requirement: WeKnora is env-gated and degrades gracefully
**Reason**: 同上，随 WeKnora 整链移除；`WEKNORA_BASE_URL` 在部署清单与环境样例中均不存在。
