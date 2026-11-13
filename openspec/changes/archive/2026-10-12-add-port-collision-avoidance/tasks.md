# Tasks: add-port-collision-avoidance

- [x] 1.1 lib/agent-serving.js：`resolveAgentPort(entryLike, {base, span})` 共享定义（合法 override 优先，越界/垃圾回退哈希）。验证：单测三态。
- [x] 1.2 deployToRegistry：列既有条目→切片占用集（含同包互撞）→环形探测→`port_override`+URL 同源；段耗尽 400；列表失败优雅回退。验证：serving 测试——预置同切片占位条目（override 钉在哈希位）→ 改判+URL 一致；无撞名→无字段；耗尽→400。
- [x] 1.3 agent-runner：两处绑定改 `resolveAgentPort`。验证：runner 测试——entry 带 override → health 端口=override；越界 override → 哈希。
- [x] 2.1 全量测试门（runner 43+serving+路由套件）。
- [x] 2.2 上线四件（platform/facet/runner-b 同滚 sha-2d6cd45+cheap-1 容器重建）+ 生产无回归实证：重部署 demo-fingpt 到 runner-b——端口仍 :8853、port_override 缺席（无撞零字段）、注册条目 enabled；真回合答「正常」。
- [x] 2.3 归档+记忆。
