## ADDED Requirements

### Requirement: runner 路由的 packId 消歧

成员 SHALL 可声明可选 `packId`（非空字符串 ≤64 或 null）作为跨包同名 agent 键的消歧绑定：声明后，
runner 路由在多命中 SHALL 以 a2a entry 的 registry path 段 `/packs/<packId>/` 过滤——钉中唯一即
远端执行；钉后仍多（同包同键多部署）或钉不中任何条 SHALL 维持 `runner-ambiguous` 诚实回退。
未声明（null）的行为 SHALL 与本需求前逐字节等价（唯一命中照常、歧义照常回退）。packId SHALL
随物化 spec 进任务并原位改写（与 carrier 同款），任务记录 SHALL 持久化该绑定。runner 路由
MUST NOT 在歧义未被消歧绑定时猜测取其一。

#### Scenario: packId 钉中跨包同名

- **WHEN** 成员 carrier=runner、persona 键命中 ≥2 个 a2a entry、且成员声明 packId 指向其一
- **THEN** 回合走该包部署的远端执行器（不判歧义、不回退）

#### Scenario: packId 钉不中仍诚实回退

- **WHEN** 成员声明的 packId 与任何命中 entry 的部署路径都不匹配（或同包内仍有多部署）
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=runner-ambiguous

#### Scenario: 未声明 packId 行为不变

- **WHEN** 成员未声明 packId（null）
- **THEN** 路由行为与本需求前逐字节等价：唯一命中照常远端、多命中照常 runner-ambiguous
