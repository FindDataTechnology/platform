## ADDED Requirements

### Requirement: wanxing-deployer ref for cloud deployment

壹座 SHALL 支持第四类线凭据 ref：`wanxing-deployer`，用于以用户自己的 sub2api `sk-` key 发起云端部署。该 ref SHALL 与 `wanxing-caller` 分立（前者承载被部署服务的自主回合成本，后者承载外部调用回合），MUST NOT 互相复用。粘贴 SHALL 校验 `sk-` 前缀；401 SHALL 置 stale 并提示重贴。该 ref SHALL 仅在 `target=cloud` 的部署 preflight 中被要求；桌面机位部署 MUST NOT 要求该 ref。

#### Scenario: 与 caller 分立

- **WHEN** 用户已连接 wanxing-caller 但未连接 wanxing-deployer
- **THEN** 云端部署 preflight 失败，外部调用回合不受影响

#### Scenario: 桌面部署不要求

- **WHEN** 用户未连接 wanxing-deployer 但机位已配对且在线
- **THEN** 桌面部署 preflight 通过

#### Scenario: 投影无密钥

- **WHEN** 查询 wanxing-deployer 连接状态
- **THEN** 响应只含 connected/stale，不含 sk- 或其片段
