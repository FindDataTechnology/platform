# registry-lineage Delta — onboard-registry-argocd

## MODIFIED Requirements

### Requirement: 独立版本身份

registry 全栈以自有版本线（`fd-x.y.z`）标识与发布，不与上游版本号比较、不暗示落后；栈内所有容器镜像一律钉版，不允许浮动 tag。

#### Scenario: 控制台版本横幅显示 fd 版本

- **WHEN** 运营者打开注册处控制台
- **THEN** 版本横幅显示 `fd-` 前缀的自有版本号，且可辨认其收敛基线为上游 1.32.0（经 ADR 与维护文档，而非版本号本身）

#### Scenario: 镜像无浮动 tag

- **WHEN** 检视部署链路的 GitOps manifest（gitee fd-infra-deploy `mcp-registry/prod/`）
- **THEN** registry、auth-server、mcpgw 三类自建/转发容器的镜像引用全部钉在明确版本 tag 上，不存在 `latest` 等浮动引用

### Requirement: 换版可回滚且市场目录不缩水

registry 容器的任何换版必须以可一步回滚的钉版方式进行；换版后必须核验壹座市场消费的全局快照内容（server 与工具可见集）相对换版前无未解释的缩减，以防读面按调用者过滤的语义变化静默缩小目录。

#### Scenario: 换版后快照核验

- **WHEN** registry 容器完成一次版本切换
- **THEN** 以市场 bridge 的同一凭据对换版前后快照做 diff，server/工具集合无未解释缺失，方可宣布换版完成

#### Scenario: 一步回滚

- **WHEN** 换版后出现不可快速修复的回归
- **THEN** 将 GitOps manifest 的镜像钉版改回上一 sha tag 并经 ArgoCD sync（或切流窗内把 cheap-1 Caddy upstream 切回 compose 双轨栈），恢复换版前行为，无需重新构建

## ADDED Requirements

### Requirement: 生产链路 GitOps 化

registry 生产链路（registry、auth-server、mcpgw、mongodb 四工作负载）运行于 cheap k3s 集群、由 ArgoCD app `mcp-registry` 声明式管理；唯一变更路径=改 gitee fd-infra-deploy `mcp-registry/prod/` 后 sync，不存在集群内直接 kubectl apply 的长期漂移源。openbao 密钥库留守 cheap-1（tailnet 可达），其迁移另立项。

#### Scenario: ArgoCD 在管且自愈

- **WHEN** 检视 cheap 集群 argocd namespace 的 app 列表并观察对集群内手工改动的行为
- **THEN** `mcp-registry` app 存在、源指向 gitee fd-infra-deploy `mcp-registry/prod/`、Synced/Healthy；对手工删除的 pod 或被直改的字段，selfHeal 在数分钟内恢复声明态

#### Scenario: 滚动即 push

- **WHEN** registry 双镜像产出新 sha tag 并需要上生产
- **THEN** 运维动作只有：改 manifest 镜像 tag → push gitee →（ArgoCD 自动或手动）sync；无 docker compose 手滚、无集群内临时镜像 hack

#### Scenario: 切流与回退

- **WHEN** 需要在 compose 双轨栈与 k8s 链路间切换生产流量
- **THEN** 切流与回退均为 cheap-1 Caddy mcp 站点块的 upstream 单行改动+reload，秒级生效；双轨观察期内 compose 栈冻结在台账登记的 sha 不再变更
