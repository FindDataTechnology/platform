# Tasks: add-tool-scope-register-shadow

## 1. 执行桥影子层

- [x] 1.1 `dsh-profile-template/platform-tool-scope.js`：新增 `installMcpToolRegisterShadow(ctx)`——`cordis.original` 解原始实例（形状意外返回 null 不装）、own-property 影子化 `register`（MCP 形状 × 映射服务器 × 越权 leaf → 不注册返回惰性 disposer；其余/异常一律 `protoRegister.call(this, …)` 透传）、per-registration 重读 filter、`ctx.effect` 安装与还原。验证：stub 单测（1.3）。
- [x] 1.2 `dsh-profile-template/platform-preset-bridge.js`：`apply()` 内 `installMcpToolGuard(ctx)` 旁安装影子（import 扩一处）。验证：桥级既有套件回归。
- [x] 1.3 `scripts/test-tool-scope-bridge.mjs` 补影子单元组：drop 判定（映射服务器越权/未映射直通/非 MCP 直通/空 allowlist 全丢）、异常透传（filter 抛错不丢正常注册）、惰性 disposer、effect 还原删除 own prop、`cordis.original` 缺失时安全不装。

## 2. web cell 顺序对齐

- [x] 2.1 `dsh-bridge.js patchArgs`：`[mcp, skills, presets, …]` → `[presets, skills, mcp, …]`（与 agent-runner/compose.js 对齐），注释同步（桥先于 mcp-client 装载是影子层前提）。验证：patchArgs 单测断言更新 + 既有 dsh-bridge 套件全绿。

## 3. 真 cordis 接缝哨兵

- [x] 3.1 新增 `scripts/test-tool-scope-register-seam.mjs`：真实 Context + systemPrompt + ToolRuntime（仓库 pin 0.1.1-rc.2/4.0.4），覆盖 D1 断言面——view 注册穿影子、丢弃不出 schemas()、非 MCP 直通、scoped 注册 receiver/scope 归属保留（scoped 不进全局）、惰性 disposer、还原原型。验证：`node --test` 全绿进根测试道。

## 4. 门禁与上线

- [x] 4.1（本地 unit 1053/1053、touched-files biome 净、typecheck+web build 绿；e2e 三件随 push 走 CI——见 4.2 前置）
- [x] 4.1 全量本地门（lint/unit/build）+ e2e 三件走 CI（聚焦收窄/兼容回归/漂移兜底不倒退）。
- [x] 4.2 镜像走标准线（org 阻断→scs001 公开镜像仓 sha-d986a12，五门全绿）→ relay OK 行+skopeo ccr 实证 → GitOps b0e7925 双清单滚 → ArgoCD hard-refresh。冒烟：pod 内对**真矩阵树 /opt/dsh（0.1.1-rc.2）跑哨兵 3/3 绿**；两生产 cell 子进程 argv 已是新序（presets 先于 mcp）+ cell 桥拷贝带影子；**runner 同滚**（cheap-1 agent-runner-dsh 重建：6 agents 复役、registry 200、planner 8801=401 活）；guard 拒绝文案代码零改动。顺带修 cheap-1 盘满（prune 8.73G）与盘满期 docker 端口簿记残留。
- [x] 4.3 上游回帖已发（discussioncomment-18860857）：双代实证 14 断言、receiver/scope 归属保留、raw-leaf 同感+发布门 fail-safe 事实、桥内嵌形态；docs/upstream-issue-dsh-mcp-client-allowedTools.md 追记（00fc925）。
