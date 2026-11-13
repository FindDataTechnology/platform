# a2a-agent-serving Delta Spec

## ADDED Requirements

### Requirement: 服务契约可声明会话工具面

服务契约 SHALL 支持可选键 `serving.toolFace`，v1 取值仅 `"chat"`：物化该部署时
SHALL 结构性裁掉内建工具面中的文件系统、命令执行、网络访问与子代理行，同时 SHALL
保留技能调用、访客问询与平台桥注入的工具（通知/问询/事项）。未声明该键的部署
SHALL 与现状逐字节一致。发布门 SHALL 校验取值枚举；未知档位以结构化错误拒绝。

#### Scenario: chat 面裁剪生效

- **WHEN** 一个角色以 `serving.toolFace: "chat"` 部署并物化
- **THEN** 其工具面不包含 bash/文件/网络/子代理工具，且包含技能调用、问询与桥注入工具

#### Scenario: 未声明零变化

- **WHEN** 一个服务契约不携带 `toolFace`
- **THEN** 物化产物与该键引入前逐字节一致

#### Scenario: 未知档位被拒

- **WHEN** 发布清单声明 `serving.toolFace: "yolo"`
- **THEN** 发布门以结构化错误拒绝，不上架
